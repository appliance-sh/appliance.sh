// Evaluate a programmatic appliance.ts/.js manifest inside a sandbox.
//
// The CLI's old loader (`importManifestModule` in utils/common.ts)
// used Node's `import()` to execute manifests directly in the host
// process — meaning a manifest could touch fs, env, network, anything
// Node could. The new loader keeps the same external contract
// (path → ManifestContext → ApplianceFullInput) but evaluates the
// source in a QuickJS WASM VM with:
//
//   * no built-in fs / process / fetch / require
//   * no module imports except `@appliance.sh/sdk` (stubbed; the real
//     schemas validate the returned object afterwards, outside the VM)
//   * memory & wall-clock limits the host can enforce
//
// The same module is invoked by the desktop wizard through the CLI
// sidecar (`appliance manifest read --json`), so both surfaces share
// one implementation.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { transform as sucraseTransform } from 'sucrase';
import { getQuickJS, type QuickJSContext, type QuickJSRuntime } from 'quickjs-emscripten';
import type { ManifestContext } from '@appliance.sh/sdk';
import { SDK_STUB_SOURCE } from './sdk-stub.js';

export interface SandboxOptions {
  /** Wall-clock timeout for the manifest evaluation (ms). Default 5000. */
  timeoutMs?: number;
  /** QuickJS memory cap (MB). Default 64. */
  memoryLimitMB?: number;
  /** QuickJS max stack (MB). Default 2. */
  maxStackMB?: number;
}

const CODE_EXTENSIONS: ReadonlySet<string> = new Set(['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs']);

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MEMORY_MB = 64;
const DEFAULT_STACK_MB = 2;

const MANIFEST_MODULE = '<appliance-manifest>';
const SDK_MODULE = '@appliance.sh/sdk';

/**
 * Read a programmatic manifest from disk and return the value the
 * manifest exports. If the default export is a function it's invoked
 * with `ctx` (async or sync), exactly matching the contract used by
 * the previous Node-based loader so callers don't need to change.
 *
 * Throws with a descriptive message on transpile errors, sandbox
 * errors (timeout, memory), or unauthorised imports.
 */
export async function evaluateManifest(
  filePath: string,
  ctx: ManifestContext,
  opts: SandboxOptions = {}
): Promise<unknown> {
  const ext = path.extname(filePath).toLowerCase();
  if (!CODE_EXTENSIONS.has(ext)) {
    throw new Error(`Unsupported manifest extension: ${ext}`);
  }
  const source = readFileSync(filePath, 'utf-8');
  return evaluateManifestSource(source, ext, ctx, opts);
}

/**
 * Same as {@link evaluateManifest} but takes source text directly.
 * Exposed so tests can exercise the sandbox without writing temp
 * files, and so the desktop sidecar can pipe content from elsewhere
 * if it ever needs to.
 */
export async function evaluateManifestSource(
  source: string,
  ext: string,
  ctx: ManifestContext,
  opts: SandboxOptions = {}
): Promise<unknown> {
  const transpiled = transpile(source, ext);

  const QuickJS = await getQuickJS();
  const runtime: QuickJSRuntime = QuickJS.newRuntime();
  runtime.setMemoryLimit((opts.memoryLimitMB ?? DEFAULT_MEMORY_MB) * 1024 * 1024);
  runtime.setMaxStackSize((opts.maxStackMB ?? DEFAULT_STACK_MB) * 1024 * 1024);

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  runtime.setInterruptHandler(() => Date.now() > deadline);

  runtime.setModuleLoader((moduleName) => {
    if (moduleName === MANIFEST_MODULE) return transpiled;
    if (moduleName === SDK_MODULE) return SDK_STUB_SOURCE;
    return {
      error: new Error(
        `Import '${moduleName}' is not allowed inside the manifest sandbox. ` +
          `Only '${SDK_MODULE}' is available; everything else (fs, fetch, ` +
          `arbitrary npm packages) is blocked.`
      ),
    };
  });

  const vm: QuickJSContext = runtime.newContext();
  try {
    return await runInVm(vm, ctx);
  } finally {
    vm.dispose();
    runtime.dispose();
  }
}

async function runInVm(vm: QuickJSContext, ctx: ManifestContext): Promise<unknown> {
  // Stash the context as a JSON string on globalThis; the runner
  // module parses it back. JSON keeps the marshalling boring (no
  // need to walk the structure manually, no risk of leaking host
  // references into the VM).
  const ctxJson = JSON.stringify(serialisableCtx(ctx));
  const ctxHandle = vm.newString(ctxJson);
  vm.setProp(vm.global, '__APPLIANCE_CTX_JSON__', ctxHandle);
  ctxHandle.dispose();

  const runner = `
import mod from '${MANIFEST_MODULE}';
const ctx = JSON.parse(globalThis.__APPLIANCE_CTX_JSON__);
const raw = (typeof mod === 'function') ? mod(ctx) : mod;
globalThis.__APPLIANCE_RESULT__ = Promise.resolve(raw);
`;

  const evalResult = vm.evalCode(runner, 'sandbox-runner.mjs', { type: 'module' });
  if (evalResult.error) {
    const errInfo = vm.dump(evalResult.error);
    evalResult.error.dispose();
    throw new Error(`Manifest evaluation failed: ${formatVmError(errInfo)}`);
  }
  evalResult.value.dispose();

  drainJobs(vm);

  const promiseHandle = vm.getProp(vm.global, '__APPLIANCE_RESULT__');
  const resolvedPromise = vm.resolvePromise(promiseHandle);
  promiseHandle.dispose();

  // resolvePromise returns a host Promise; settle it by pumping jobs
  // until the underlying QuickJS promise resolves. Pump-then-await is
  // the order quickjs-emscripten's own examples use.
  drainJobs(vm);
  const resolved = await resolvedPromise;
  if (resolved.error) {
    const errInfo = vm.dump(resolved.error);
    resolved.error.dispose();
    throw new Error(`Manifest function rejected: ${formatVmError(errInfo)}`);
  }
  const value = vm.dump(resolved.value);
  resolved.value.dispose();
  return value;
}

function drainJobs(vm: QuickJSContext): void {
  // Cap on iterations is belt-and-braces against a pathological
  // promise chain. The interrupt handler is the real timeout backstop.
  for (let i = 0; i < 1000; i += 1) {
    const result = vm.runtime.executePendingJobs(100);
    if (result.error) {
      const errInfo = vm.dump(result.error);
      result.error.dispose();
      throw new Error(`Manifest microtask failed: ${formatVmError(errInfo)}`);
    }
    if (result.value === 0) return;
  }
  throw new Error('Manifest microtask queue did not drain (1000-iteration cap hit)');
}

function transpile(source: string, ext: string): string {
  // .js / .mjs / .cjs: hand straight to QuickJS. .ts / .mts / .cts:
  // strip types with Sucrase (no type-checking, no bundling — types
  // only). We also preserve dynamic imports so a manifest that tries
  // one fails inside the sandbox loader (clear "not allowed" error)
  // rather than at transpile time.
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') return source;
  try {
    const { code } = sucraseTransform(source, {
      transforms: ['typescript'],
      disableESTransforms: true,
      keepUnusedImports: false,
      preserveDynamicImport: true,
    });
    return code;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to transpile TypeScript manifest: ${reason}`);
  }
}

function serialisableCtx(ctx: ManifestContext): ManifestContext {
  // process.env values can be `undefined`; JSON.stringify drops them
  // silently, which is fine, but we also strip non-string entries
  // proactively so manifests see exactly the shape ManifestContext
  // documents (Record<string, string | undefined>).
  const env: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(ctx.env ?? {})) {
    if (typeof v === 'string') env[k] = v;
  }
  return { ...ctx, env };
}

function formatVmError(info: unknown): string {
  if (info && typeof info === 'object') {
    const rec = info as Record<string, unknown>;
    const message = typeof rec.message === 'string' ? rec.message : undefined;
    const stack = typeof rec.stack === 'string' ? rec.stack : undefined;
    if (message && stack) return `${message}\n${stack}`;
    if (message) return message;
  }
  return String(info);
}
