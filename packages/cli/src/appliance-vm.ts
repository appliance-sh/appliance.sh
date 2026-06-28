import { Command } from 'commander';
import { confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  bootstrapInClusterApiServer,
  ensureDockerRunning,
  ensureHelperBinOnPath,
  waitForApiServerUrl,
  apiServerUrlForHostPort,
  DEFAULT_LOCAL_NAMESPACE,
} from '@appliance.sh/helper';
import type { ProgressEvent } from '@appliance.sh/helper';
import { createApplianceClient, VERSION } from '@appliance.sh/sdk';
import { saveCredentials } from './utils/credentials.js';
import { readProfiles, removeProfile } from './utils/profile-store.js';

// `appliance vm` — the microVM runtime engine (appliance-vm), the sole
// local runtime now that bare k3d has been removed. Workloads run inside
// an isolated VM that Appliance itself boots:
// no docker provider required for the cluster, only for building and
// pushing application images.
//
// The heavy lifting lives in the `appliance-vm` Rust binary; this
// command drives it and layers the Appliance control plane on top
// (in-VM api-server bootstrap + credential registration), ending at
// the exact same DX as every other engine:
//
//   appliance vm up
//   appliance deploy <project> <env> --profile microvm
//   → http://<project>-<env>.appliance.localhost:8081

ensureHelperBinOnPath();

const DEFAULT_VM_NAME = 'appliance';
// Mirrors VmSpec defaults in packages/vm/src/spec.rs — keep in sync.
// These are the *default* VM's canonical ports; additional VMs get an
// allocated block, read per-VM from their persisted spec (vmPorts).
const DEFAULT_VM_PORTS = { hostPort: 8081, apiPort: 6443, registryPort: 5052, egressPort: 5053 } as const;

// The microVM runs the host's CPU architecture — Virtualization.framework
// doesn't emulate — so the api-server image we push must carry a matching
// `linux/<arch>` variant or it crashloops with `exec format error`.
const VM_HOST_ARCH: 'arm64' | 'amd64' = process.arch === 'arm64' ? 'arm64' : 'amd64';

/** The credentials profile a VM owns. The default VM keeps the plain
 *  `microvm` profile (back-compat + parity with the desktop); each
 *  additional VM gets its own `microvm-<name>` profile so multiple VMs
 *  coexist without clobbering each other's credentials. */
function profileForVm(name: string): string {
  return name === DEFAULT_VM_NAME ? 'microvm' : `microvm-${name}`;
}

/** Read a VM's forwarded host ports from its persisted spec, falling
 *  back to the canonical defaults when the spec isn't written yet. */
function vmPorts(name: string): { hostPort: number; apiPort: number; registryPort: number; egressPort: number } {
  try {
    const raw = fs.readFileSync(path.join(vmDir(name), 'vm.json'), 'utf8');
    const spec = JSON.parse(raw) as Partial<typeof DEFAULT_VM_PORTS>;
    return {
      hostPort: spec.hostPort ?? DEFAULT_VM_PORTS.hostPort,
      apiPort: spec.apiPort ?? DEFAULT_VM_PORTS.apiPort,
      registryPort: spec.registryPort ?? DEFAULT_VM_PORTS.registryPort,
      egressPort: spec.egressPort ?? DEFAULT_VM_PORTS.egressPort,
    };
  } catch {
    return { ...DEFAULT_VM_PORTS };
  }
}

/** Whether a VM was provisioned as a development environment, read from
 *  its persisted spec (the engine sets `dev` on `vm dev up`). */
function isDevVm(name: string): boolean {
  try {
    const raw = fs.readFileSync(path.join(vmDir(name), 'vm.json'), 'utf8');
    return (JSON.parse(raw) as { dev?: boolean }).dev === true;
  } catch {
    return false;
  }
}

const program = new Command();
program.description('manage the microVM runtime (isolated VM engine, no docker required)');

function vmBinary(): string {
  // Resolution order: explicit override → managed install → PATH →
  // the repo build. The desktop installs into ~/.appliance/bin (and
  // the npm distribution will ship per-platform binaries); the repo
  // paths keep `pnpm`-checkout workflows working.
  const candidates = [
    process.env.APPLIANCE_VM,
    path.join(os.homedir(), '.appliance', 'bin', 'appliance-vm'),
    'appliance-vm',
    // Repo-checkout fallbacks, resolved from the working directory.
    path.resolve('packages/vm/target/release/appliance-vm'),
    path.resolve('packages/vm/target/debug/appliance-vm'),
  ].filter((c): c is string => Boolean(c));
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['--version'], { stdio: 'ignore' });
    if (probe.status === 0) return candidate;
  }
  console.error(
    chalk.red(
      'appliance-vm binary not found. Build it with `cargo build && ./scripts/sign-dev.sh` in packages/vm, or set APPLIANCE_VM.'
    )
  );
  process.exit(1);
}

function vmDir(name: string): string {
  return path.join(os.homedir(), '.appliance', 'vm', name);
}

function runVm(args: string[]): number {
  const bin = vmBinary();
  const r = spawnSync(bin, args, { stdio: 'inherit' });
  return r.status ?? 1;
}

const printProgress = (event: ProgressEvent) => {
  const prefix = event.type === 'error' ? chalk.red('✗') : event.type === 'done' ? chalk.green('✓') : chalk.cyan('»');
  console.log(`${prefix} ${chalk.dim(event.tool)} ${event.message}`);
};

// ---- up ---------------------------------------------------------------

program
  .command('up')
  .description('boot the microVM, bootstrap the in-VM api-server, and log in')
  .option('--name <name>', 'VM name', DEFAULT_VM_NAME)
  .option('--image <ref>', 'api-server image to run in the VM (must exist in the local docker daemon)')
  .option('--timeout <seconds>', 'seconds to wait for the kubernetes endpoint', '600')
  .option('--cpus <n>', 'virtual CPUs for the VM (persisted; takes effect on next boot)', parsePositiveInt)
  .option('--memory <MiB>', 'guest memory in MiB (persisted; takes effect on next boot)', parsePositiveInt)
  .action(async (opts: { name: string; image?: string; timeout: string; cpus?: number; memory?: number }) => {
    try {
      await runUp(opts.name, opts.image, Number.parseInt(opts.timeout, 10), {
        cpus: opts.cpus,
        memory: opts.memory,
      });
    } catch (err) {
      console.error(chalk.red(err instanceof Error ? err.message : String(err)));
      process.exit(1);
    }
  });

/** Commander option parser: a positive integer, or a clear failure.
 *  Used for --cpus / --memory so a bad value is rejected host-side
 *  before the engine ever sees it. */
function parsePositiveInt(value: string): number {
  const n = Number.parseInt(value, 10);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`expected a positive integer, got '${value}'`);
  }
  return n;
}

async function runUp(
  name: string,
  imageOverride: string | undefined,
  timeout: number,
  resources: { cpus?: number; memory?: number; dev?: boolean; mount?: string } = {}
): Promise<void> {
  const profile = profileForVm(name);
  const ports = vmPorts(name);
  // 1. Boot the VM + wait for its kubernetes endpoint. Per-VM resource
  //    overrides are persisted into the spec by the engine, so they
  //    survive restarts; omitting them keeps the VM's current sizing.
  //    `--dev` provisions the VM as a development environment (persisted
  //    one-way, so a later plain `up` keeps it a dev VM).
  const upArgs = ['up', name, '--timeout', String(timeout)];
  if (resources.cpus !== undefined) upArgs.push('--cpus', String(resources.cpus));
  if (resources.memory !== undefined) upArgs.push('--memory', String(resources.memory));
  if (resources.dev) upArgs.push('--dev');
  // Resolve --mount to an absolute path so it's unambiguous to the
  // engine regardless of its working directory (it canonicalizes too).
  if (resources.mount) upArgs.push('--mount', path.resolve(resources.mount));
  const status = runVm(upArgs);
  if (status !== 0) process.exit(status);
  // Re-read ports: `vm up` creates the spec (with allocated ports) if
  // it didn't exist, so the canonical-fallback above may be stale now.
  Object.assign(ports, vmPorts(name));
  const kubeconfigPath = path.join(vmDir(name), 'kubeconfig.yaml');
  const kubeconfigDeadline = Date.now() + 30_000;
  while (!fs.existsSync(kubeconfigPath)) {
    if (Date.now() >= kubeconfigDeadline) {
      throw new Error(`expected kubeconfig at ${kubeconfigPath} after appliance-vm up`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  // 2. Wait for the in-VM registry forward — image delivery for both
  //    the api-server below and every later `appliance deploy` rides
  //    this. First boot includes the registry:2 image pull.
  console.log(chalk.cyan('» waiting for the in-VM registry'));
  await waitForRegistry(`http://127.0.0.1:${ports.registryPort}/v2/`, 240_000);

  // 3. Deliver the api-server image into the VM's registry. The image
  //    must be present in the local docker daemon (built via
  //    packages/api-server's docker-prep.sh); docker is needed for
  //    image *builds* anyway — the cluster itself no longer depends on
  //    it. `docker save --platform` selects the VM's architecture from
  //    a single-arch *or* multi-arch image, so a multi-arch build is
  //    delivered correctly and a pure cross-arch image fails fast with
  //    an actionable message rather than an `exec format error`.
  await ensureDockerRunning({ onProgress: printProgress });
  // Deploy by digest: pushing a different image under a reused tag
  // would leave the Deployment spec unchanged (no rollout) and
  // IfNotPresent would keep serving the stale cached image.
  const vmImage = await deliverApiServerImage(
    imageOverride,
    `localhost:${ports.registryPort}/appliance-api-server:latest`
  );

  // 4. In-VM api-server: the shared in-cluster bootstrap, pointed at the
  //    VM's kubeconfig and registry.
  const existing = readProfiles().profiles[profile];
  const apiServerUrl = apiServerUrlForHostPort(ports.hostPort);
  const runtime = {
    dataDir: '/persist/appliance-data',
    hostPort: ports.hostPort,
    registryUrl: `localhost:${ports.registryPort}`,
  };
  let verified = false;
  if (existing) {
    // Reconcile manifests, then keep existing credentials when they
    // still authenticate — no-key-sprawl behavior.
    try {
      await waitForApiServerUrl(apiServerUrl, 30_000);
      const client = createApplianceClient({
        baseUrl: apiServerUrl,
        credentials: { keyId: existing.keyId, secret: existing.secret },
      });
      verified = (await client.listProjects()).success;
    } catch {
      verified = false;
    }
  }
  if (verified) {
    console.log(`${chalk.green('✓')} api-server reachable; profile ${chalk.bold(profile)} already authenticated`);
  } else {
    const result = await bootstrapInClusterApiServer({
      runtime,
      image: vmImage,
      kubeconfigPath,
      keyName: name === DEFAULT_VM_NAME ? 'MicroVM Runtime' : `MicroVM Runtime (${name})`,
      onProgress: printProgress,
    });
    saveCredentials({ apiUrl: result.apiServerUrl, keyId: result.apiKey.id, secret: result.apiKey.secret }, profile);
    console.log(`${chalk.green('✓')} api-server bootstrapped; credentials saved to profile ${chalk.bold(profile)}`);
  }

  // Publish the egress policy into the cluster now that the namespace
  // exists, so the api-server can confine workloads per policy. Best-
  // effort: a permissive default policy is a harmless no-op.
  runVm(['egress', 'sync', name]);

  console.log();
  console.log(chalk.green(`MicroVM runtime '${name}' is up.`));
  console.log(`  API server:  ${apiServerUrl}`);
  console.log(`  Ingress:     http://*.appliance.localhost:${ports.hostPort}`);
  console.log(`  Profile:     ${profile}`);
  console.log(`  Deploy:      appliance deploy <project> <environment> --profile ${profile}`);
  if (resources.dev) {
    const nameFlag = name === DEFAULT_VM_NAME ? '' : ` --name ${name}`;
    const workspace = resources.mount
      ? `/persist/workspace ← ${path.resolve(resources.mount)} (shared from the host)`
      : '/persist/workspace (persists across stop/up)';
    console.log(`  Workspace:   ${workspace}`);
    console.log(`  Shell:       appliance vm dev shell${nameFlag}`);
    console.log(chalk.dim('  (the dev toolchain finishes installing in the background on first boot)'));
  }
}

async function waitForRegistry(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3_000) });
      if (res.ok) return;
    } catch {
      // keep polling
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `in-VM registry not reachable at ${url} after ${Math.round(timeoutMs / 1000)}s.\n` +
          'The VM booted but its registry forward never came up. Inspect the boot log with `appliance vm console`, ' +
          'and run `appliance doctor` to confirm the host prerequisites (Docker, free ports) are healthy.'
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}

/**
 * Deliver the api-server image into the VM's host-loopback registry,
 * extracting the VM's architecture (= the host's). The delivery is
 * host-side — `docker save` + `crane push` — because a plain `docker
 * push` executes inside the docker VM (colima/Docker Desktop), where
 * the host's 127.0.0.1 (and therefore the microVM's forwarded
 * registry) doesn't exist.
 *
 * `docker save --platform linux/<arch>` is the source of truth for
 * architecture: it pulls exactly that platform out of a single-arch
 * *or* multi-arch image, and fails cleanly when the image carries no
 * matching variant — so a multi-arch build "just works" and a pure
 * cross-arch image is rejected with guidance instead of crashlooping.
 * Returns the digest-qualified ref crane pushes (deploy by digest so a
 * reused tag still triggers a rollout).
 */
async function deliverApiServerImage(imageOverride: string | undefined, targetRef: string): Promise<string> {
  const candidates = imageOverride
    ? [imageOverride]
    : [`appliance-api-server:${VM_HOST_ARCH}`, 'appliance-api-server:latest'];
  // Keep only refs that actually exist locally, remembering each one's
  // host-resolved architecture for diagnostics + ordering.
  let present = candidates
    .map((ref) => ({ ref, arch: inspectArch(ref) }))
    .filter((c): c is { ref: string; arch: string } => c.arch !== null);

  // Nothing local and no explicit --image: pull the pinned published
  // image so a fresh machine boots a VM without a manual build or
  // `docker tag`. Mirrors the bootstrap default (phases/phase2.ts) — the
  // same versioned ghcr ref every surface uses.
  if (present.length === 0 && !imageOverride) {
    const pulled = pullPublishedApiServer();
    if (pulled) present = [pulled];
  }

  if (present.length === 0) throw new Error(missingImageMessage(imageOverride));

  // Try a ref whose host-resolved arch already matches first (a
  // properly-loaded multi-arch image resolves to the host platform),
  // then any other present ref. `docker save --platform` decides
  // success either way; this only affects which tar we attempt first.
  const ordered = [
    ...present.filter((c) => c.arch === VM_HOST_ARCH),
    ...present.filter((c) => c.arch !== VM_HOST_ARCH),
  ];

  const crane = await ensureCrane();
  const tarPath = path.join(os.tmpdir(), `appliance-image-${process.pid}.tar`);
  try {
    let lastSaveErr = '';
    for (const { ref, arch } of ordered) {
      console.log(chalk.cyan(`» delivering ${ref} (linux/${VM_HOST_ARCH}) into the VM registry`));
      let save = spawnSync('docker', ['save', '--platform', `linux/${VM_HOST_ARCH}`, '-o', tarPath, ref], {
        encoding: 'utf8',
      });
      // Fallback for docker builds without `save --platform`: when the
      // image already resolves to the host arch, a plain save delivers
      // the right variant.
      if (save.status !== 0 && arch === VM_HOST_ARCH) {
        save = spawnSync('docker', ['save', '-o', tarPath, ref], { encoding: 'utf8' });
      }
      if (save.status === 0) return cranePush(crane, tarPath, targetRef);
      lastSaveErr = (save.stderr ?? '').trim();
      // The ref exists but doesn't carry our arch — try the next
      // candidate; the throw below explains the fix if none do.
    }
    throw new Error(wrongArchMessage(present, lastSaveErr));
  } finally {
    fs.rmSync(tarPath, { force: true });
  }
}

/** The published api-server image for this CLI's release. Pinned to the
 *  SDK VERSION exactly like the cloud bootstrap default
 *  (packages/bootstrap/src/phases/phase2.ts) so every surface seeds the
 *  same versioned image. */
const PUBLISHED_API_SERVER_IMAGE = `ghcr.io/appliance-sh/api-server:${VERSION.replace(/^v/, '')}`;

/** Pull the pinned published api-server image into the local docker
 *  daemon as a last resort when nothing matching is present, selecting
 *  the VM's arch out of the multi-arch manifest. Returns the ref + its
 *  host-resolved arch on success, or null when the pull fails (offline,
 *  no ghcr access, or an unreleased VERSION with no matching tag) — the
 *  caller then surfaces the build/--image guidance. */
function pullPublishedApiServer(): { ref: string; arch: string } | null {
  const ref = PUBLISHED_API_SERVER_IMAGE;
  console.log(chalk.cyan(`» no local api-server image — pulling ${ref}`));
  const pull = spawnSync('docker', ['pull', '--platform', `linux/${VM_HOST_ARCH}`, ref], { stdio: 'inherit' });
  if (pull.status !== 0) return null;
  const arch = inspectArch(ref);
  return arch ? { ref, arch } : null;
}

/** Host-resolved architecture of a local image, or null when it isn't
 *  in the docker daemon. With the containerd image store a multi-arch
 *  image resolves to the host platform whenever it carries one. */
function inspectArch(ref: string): string | null {
  const r = spawnSync('docker', ['image', 'inspect', '--format', '{{.Architecture}}', ref], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  return r.stdout.trim() || null;
}

/** `crane push` an already-saved image tar to the host-loopback
 *  registry, returning the digest-qualified ref crane prints last. */
function cranePush(crane: string, tarPath: string, targetRef: string): string {
  const r = spawnSync(crane, ['push', '--insecure', tarPath, targetRef], {
    stdio: ['ignore', 'pipe', 'inherit'],
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`crane push to ${targetRef} failed`);
  const lines = r.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const digestRef = lines[lines.length - 1];
  if (!digestRef || !digestRef.includes('@sha256:')) {
    throw new Error(`could not parse digest from crane push output: ${r.stdout.slice(-300)}`);
  }
  console.log(chalk.dim(`pushed ${digestRef}`));
  return digestRef;
}

function missingImageMessage(imageOverride: string | undefined): string {
  if (imageOverride) {
    return `image ${imageOverride} not found in the local docker daemon — build or pull it first, or pass a different --image.`;
  }
  return (
    `no local appliance-api-server image, and pulling ${PUBLISHED_API_SERVER_IMAGE} failed\n` +
    '(check network / ghcr access, or that this CLI version has a published image — `appliance doctor` diagnoses these).\n' +
    `Build one for the VM's architecture (linux/${VM_HOST_ARCH}):\n` +
    `  cd packages/api-server && docker build --platform linux/${VM_HOST_ARCH} -t appliance-api-server:${VM_HOST_ARCH} .\n` +
    '(docker-prep.sh stages the build context; its default image targets Lambda/amd64.) Or pass --image <ref>.'
  );
}

function wrongArchMessage(present: { ref: string; arch: string }[], saveErr: string): string {
  const found = present.map((c) => `${c.ref} (${c.arch})`).join(', ');
  return (
    `no appliance-api-server image provides the VM's architecture (linux/${VM_HOST_ARCH}).\n` +
    `Found: ${found}.\n` +
    `The microVM runs ${VM_HOST_ARCH} (Virtualization.framework doesn't emulate), so the image must carry a linux/${VM_HOST_ARCH} variant.\n` +
    'Build one:\n' +
    `  cd packages/api-server && docker build --platform linux/${VM_HOST_ARCH} -t appliance-api-server:${VM_HOST_ARCH} .\n` +
    'A multi-arch build only counts when loaded into the docker image store (buildx --load with the containerd image store), not just the build cache. Or pass --image <ref>.' +
    (saveErr ? `\n(docker save: ${saveErr})` : '')
  );
}

async function ensureCrane(): Promise<string> {
  const { runInstall, helperBinDir } = await import('@appliance.sh/helper');
  const outcomes = await runInstall({ tools: ['crane'], onProgress: printProgress });
  const failed = outcomes.find((o) => o.status === 'failed');
  if (failed) throw new Error(`crane install failed: ${failed.message}`);
  const managed = path.join(helperBinDir(), 'crane');
  return fs.existsSync(managed) ? managed : 'crane';
}

// ---- passthrough lifecycle ---------------------------------------------

for (const [cmd, desc] of [
  ['stop', 'stop the microVM (state is preserved)'],
  ['status', 'report microVM state as JSON'],
] as const) {
  program
    .command(cmd)
    .description(desc)
    .option('--name <name>', 'VM name', DEFAULT_VM_NAME)
    .action((opts: { name: string }) => {
      process.exit(runVm([cmd, opts.name]));
    });
}

// `delete`/`prune` are not plain passthroughs. The Rust engine removes
// the VM and its on-disk state, but the credential profile that `vm up`
// minted (`microvm` for the default VM, `microvm-<name>` otherwise)
// lives in the CLI profile store — which the engine knows nothing about.
// Without pruning it, a deleted VM leaves an orphan cluster behind in
// both the CLI and the desktop (both read ~/.appliance/profiles.json).

/** Delete a microVM via the engine, then prune its CLI credential
 *  profile. The profile is only removed once the engine confirms the VM
 *  is gone (exit 0), so a failed delete never strips a usable profile.
 *  Returns the engine's exit code. */
function deleteVmAndProfile(name: string): number {
  const code = runVm(['delete', name]);
  if (code === 0) {
    const profile = profileForVm(name);
    if (removeProfile(profile)) {
      console.log(chalk.dim(`removed credential profile '${profile}'`));
    }
  }
  return code;
}

program
  .command('delete')
  .description('delete the microVM, its state, and its credential profile')
  .option('--name <name>', 'VM name', DEFAULT_VM_NAME)
  .action((opts: { name: string }) => {
    process.exit(deleteVmAndProfile(opts.name));
  });

program
  .command('prune')
  .description('delete every stopped microVM and its credential profile')
  .option('-f, --force', 'skip the confirmation prompt', false)
  .action(async (opts: { force: boolean }) => {
    const bin = vmBinary();
    const r = spawnSync(bin, ['list'], { encoding: 'utf8' });
    if (r.status !== 0) {
      process.stderr.write(r.stderr ?? '');
      process.exit(r.status ?? 1);
    }
    const stopped = (JSON.parse(r.stdout) as { name: string; running: boolean }[]).filter((e) => !e.running);
    if (stopped.length === 0) {
      console.log(chalk.dim('no stopped microVMs to prune'));
      return;
    }
    if (!opts.force) {
      const names = stopped.map((e) => e.name).join(', ');
      const ok = await confirm({
        message: `Delete ${stopped.length} stopped microVM(s) (${names}) and their credential profiles?`,
        default: false,
      });
      if (!ok) {
        console.log(chalk.yellow('aborted'));
        return;
      }
    }
    let deleted = 0;
    for (const e of stopped) {
      if (deleteVmAndProfile(e.name) === 0) deleted++;
      else console.error(chalk.red(`failed to delete '${e.name}'`));
    }
    console.log(`pruned ${deleted}/${stopped.length} stopped microVM(s)`);
  });

program
  .command('console')
  .description("print the microVM's console log")
  .option('--name <name>', 'VM name', DEFAULT_VM_NAME)
  .option('-f, --follow', 'follow the log as it grows', false)
  .action((opts: { name: string; follow: boolean }) => {
    const args = ['console', opts.name];
    if (opts.follow) args.push('-f');
    process.exit(runVm(args));
  });

program
  .command('kubeconfig')
  .description("print the microVM's kubeconfig path (use: export KUBECONFIG=$(appliance vm kubeconfig))")
  .option('--name <name>', 'VM name', DEFAULT_VM_NAME)
  .action((opts: { name: string }) => {
    console.log(kubeconfigOrExit(opts.name));
  });

// ---- exec / shell -------------------------------------------------------

function kubeconfigOrExit(name: string): string {
  const p = path.join(vmDir(name), 'kubeconfig.yaml');
  if (!fs.existsSync(p)) {
    console.error(chalk.red(`no kubeconfig at ${p} — is the VM up? (appliance vm up)`));
    process.exit(1);
  }
  return p;
}

/** kubectl exec's -t needs a real terminal on both ends; piped runs
 *  (CI, scripts) still work interactively on stdin alone. */
function ttyFlag(): string {
  return process.stdin.isTTY && process.stdout.isTTY ? '-it' : '-i';
}

program
  .command('exec')
  .description('run a command in a workload pod (interactive shell by default)')
  .option('--name <name>', 'VM name', DEFAULT_VM_NAME)
  .option('-n, --namespace <ns>', 'kubernetes namespace', DEFAULT_LOCAL_NAMESPACE)
  .argument('<pod>', 'pod (any kubectl target works, e.g. deploy/my-app)')
  .argument('[command...]', 'command to run (default: /bin/sh)')
  .action((pod: string, command: string[], opts: { name: string; namespace: string }) => {
    const kubeconfig = kubeconfigOrExit(opts.name);
    const r = spawnSync(
      'kubectl',
      [
        '--kubeconfig',
        kubeconfig,
        '-n',
        opts.namespace,
        'exec',
        ttyFlag(),
        pod,
        '--',
        ...(command.length ? command : ['/bin/sh']),
      ],
      { stdio: 'inherit' }
    );
    process.exit(r.status ?? 1);
  });

/** Resolve the VM's single k3s node name from its kubeconfig, or '' if
 *  it can't be read (VM down / kubeconfig missing). The host shell and
 *  dev commands all target `node/<name>` via `kubectl debug`. */
function resolveNodeName(kubeconfig: string): string {
  const node = spawnSync(
    'kubectl',
    ['--kubeconfig', kubeconfig, 'get', 'nodes', '-o', 'jsonpath={.items[0].metadata.name}'],
    { encoding: 'utf8' }
  );
  return node.status === 0 ? node.stdout.trim() : '';
}

/** Open a shell into the VM host itself. `kubectl debug node/` attaches
 *  a pod with the VM's root fs at /host; chroot turns it into a real VM
 *  shell — no SSH or guest agent needed, it rides the same kubeconfig as
 *  everything else, and --profile=sysadmin grants privileged +
 *  hostPID/hostNetwork. `entry` is the argv run under the chroot.
 *  Returns the child's exit code (caller decides whether to exit). */
function runHostShell(name: string, entry: string[]): number {
  const kubeconfig = kubeconfigOrExit(name);
  const nodeName = resolveNodeName(kubeconfig);
  if (!nodeName) {
    console.error(chalk.red('could not resolve the VM node — is the VM up? (appliance vm up)'));
    return 1;
  }
  const r = spawnSync(
    'kubectl',
    [
      '--kubeconfig',
      kubeconfig,
      'debug',
      `node/${nodeName}`,
      ttyFlag(),
      '--image=busybox:1.36',
      '--profile=sysadmin',
      '--',
      'chroot',
      '/host',
      ...entry,
    ],
    { stdio: 'inherit' }
  );
  // kubectl debug leaves its debugger pod behind by design; sweep ours
  // so repeated shells don't accumulate Completed pods.
  cleanupNodeDebuggerPods(kubeconfig, nodeName);
  return r.status ?? 1;
}

/** The resident VM process serves this Unix socket while the VM runs
 *  (and was booted with a vsock-capable engine); `appliance-vm shell`
 *  rides it for a fast, k3s-independent shell. */
function shellSock(name: string): string {
  return path.join(vmDir(name), 'shell.sock');
}

/** Open an interactive shell, preferring the fast vsock channel
 *  (`appliance-vm shell`, no k3s, no debugger pod) when its relay socket
 *  is up, and falling back to the kubectl-debug host shell otherwise
 *  (older VMs, or while the guest agent is still starting). `fallback`
 *  is the chroot argv used on the kubectl path. */
function runInteractiveShell(name: string, fallback: string[], root = false): number {
  if (fs.existsSync(shellSock(name))) {
    // The vsock agent drops to the non-root `appliance` user by default;
    // `--root` lands a root shell via the agent's escape hatch.
    const args = root ? ['shell', name, '--root'] : ['shell', name];
    const r = spawnSync(vmBinary(), args, { stdio: 'inherit' });
    return r.status ?? 1;
  }
  // The kubectl-debug fallback already chroots in as root, so --root is
  // a no-op there.
  return runHostShell(name, fallback);
}

/** Run one command in the VM host and capture its stdout (no TTY) — the
 *  quiet probe behind `vm dev status`. Debugger-session chatter goes to
 *  the inherited stderr's /dev/null, so the returned stdout is clean. */
function hostExec(name: string, command: string): { status: number; stdout: string } {
  const kubeconfig = kubeconfigOrExit(name);
  const nodeName = resolveNodeName(kubeconfig);
  if (!nodeName) return { status: 1, stdout: '' };
  const r = spawnSync(
    'kubectl',
    [
      '--kubeconfig',
      kubeconfig,
      'debug',
      `node/${nodeName}`,
      '-i',
      '--image=busybox:1.36',
      '--profile=sysadmin',
      '--',
      'chroot',
      '/host',
      '/bin/sh',
      '-c',
      command,
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
  );
  cleanupNodeDebuggerPods(kubeconfig, nodeName);
  return { status: r.status ?? 1, stdout: (r.stdout ?? '').trim() };
}

program
  .command('shell')
  .description(
    'open a shell inside the VM as the non-root appliance user (--root for root; or run one command: appliance vm shell -- uname -a)'
  )
  .option('--name <name>', 'VM name', DEFAULT_VM_NAME)
  .option('--root', 'land a root shell instead of the non-root appliance user', false)
  .argument('[command...]', 'command to run instead of an interactive shell')
  .action((command: string[], opts: { name: string; root: boolean }) => {
    // One-shot commands go through kubectl-debug `sh -c` (clean output +
    // an exit code); an interactive shell prefers the fast vsock path.
    if (command.length) {
      process.exit(runHostShell(opts.name, ['/bin/sh', '-c', command.join(' ')]));
    }
    process.exit(runInteractiveShell(opts.name, ['/bin/sh'], opts.root));
  });

function cleanupNodeDebuggerPods(kubeconfig: string, nodeName: string): void {
  const list = spawnSync(
    'kubectl',
    ['--kubeconfig', kubeconfig, 'get', 'pods', '-o', 'jsonpath={.items[*].metadata.name}'],
    { encoding: 'utf8' }
  );
  if (list.status !== 0) return;
  const debuggers = list.stdout.split(/\s+/).filter((name) => name.startsWith(`node-debugger-${nodeName}-`));
  if (debuggers.length === 0) return;
  spawnSync('kubectl', ['--kubeconfig', kubeconfig, 'delete', 'pod', '--wait=false', ...debuggers], {
    stdio: 'ignore',
  });
}

// ---- dev (development environment) -------------------------------------

// Interactive login into the dev workspace: a stable HOME on the
// persistent disk, cd into the workspace, and bash when the toolchain
// has installed it (falling back to sh while it's still provisioning).
const DEV_SHELL_LOGIN =
  'export HOME=/persist/home; cd /persist/workspace 2>/dev/null || true; ' +
  'if command -v bash >/dev/null 2>&1; then exec bash -l; else exec sh -l; fi';

const dev = program
  .command('dev')
  .description('run the microVM as a development environment (provisioned host + persistent workspace)');

dev
  .command('up')
  .description('boot a microVM as a dev environment (toolchain + persistent /persist/workspace)')
  .option('--name <name>', 'VM name', DEFAULT_VM_NAME)
  .option('--image <ref>', 'api-server image to run in the VM (must exist in the local docker daemon)')
  .option('--timeout <seconds>', 'seconds to wait for the kubernetes endpoint', '600')
  .option('--cpus <n>', 'virtual CPUs for the VM (persisted; takes effect on next boot)', parsePositiveInt)
  .option('--memory <MiB>', 'guest memory in MiB (persisted; takes effect on next boot)', parsePositiveInt)
  .option('--mount <path>', 'share a host folder into /persist/workspace (edit on host, run in VM)')
  .action(
    async (opts: { name: string; image?: string; timeout: string; cpus?: number; memory?: number; mount?: string }) => {
      try {
        await runUp(opts.name, opts.image, Number.parseInt(opts.timeout, 10), {
          cpus: opts.cpus,
          memory: opts.memory,
          dev: true,
          mount: opts.mount,
        });
      } catch (err) {
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }
    }
  );

dev
  .command('shell')
  .description('open a shell in the dev workspace (or run one command: appliance vm dev shell -- npm test)')
  .option('--name <name>', 'VM name', DEFAULT_VM_NAME)
  .argument('[command...]', 'command to run instead of an interactive shell')
  .action((command: string[], opts: { name: string }) => {
    if (!isDevVm(opts.name)) {
      console.error(
        chalk.red(
          `VM '${opts.name}' is not a dev environment — create one with \`appliance vm dev up${
            opts.name === DEFAULT_VM_NAME ? '' : ` --name ${opts.name}`
          }\`.`
        )
      );
      process.exit(1);
    }
    // One-shot commands run on kubectl-debug (clean output + exit code);
    // an interactive dev shell prefers the fast vsock path, which lands
    // in /persist/workspace via the guest agent.
    if (command.length) {
      const script = `export HOME=/persist/home; cd /persist/workspace 2>/dev/null || true; ${command.join(' ')}`;
      process.exit(runHostShell(opts.name, ['/bin/sh', '-c', script]));
    }
    process.exit(runInteractiveShell(opts.name, ['/bin/sh', '-c', DEV_SHELL_LOGIN]));
  });

dev
  .command('status')
  .description('report whether the VM is a dev environment and if its workspace + toolchain are ready')
  .option('--name <name>', 'VM name', DEFAULT_VM_NAME)
  .action((opts: { name: string }) => {
    const isDev = isDevVm(opts.name);
    const bin = vmBinary();
    const s = spawnSync(bin, ['status', opts.name], { encoding: 'utf8' });
    let exists = false;
    let running = false;
    try {
      const j = JSON.parse(s.stdout) as { exists?: boolean; running?: boolean };
      exists = !!j.exists;
      running = !!j.running;
    } catch {
      // status JSON unparseable — treat as not-defined below.
    }
    if (!exists) {
      console.log(chalk.dim(`no microVM named '${opts.name}' — create one with \`appliance vm dev up\``));
      process.exit(1);
    }
    const nameFlag = opts.name === DEFAULT_VM_NAME ? '' : ` --name ${opts.name}`;
    console.log(`VM:          ${opts.name}`);
    console.log(`Dev env:     ${isDev ? chalk.green('yes') : chalk.dim('no')}`);
    console.log(`State:       ${running ? chalk.green('running') : chalk.dim('stopped')}`);
    if (!isDev) {
      console.log(chalk.dim(`  promote it with: appliance vm dev up${nameFlag}`));
      return;
    }
    if (!running) {
      console.log(chalk.dim(`  start it with: appliance vm dev up${nameFlag}`));
      return;
    }
    // Quiet in-guest probe for the workspace + the toolchain marker the
    // background apk install drops on completion.
    const probe = hostExec(
      opts.name,
      'test -d /persist/workspace && echo workspace; test -f /persist/.dev-ready && echo ready'
    );
    const hasWorkspace = probe.stdout.includes('workspace');
    const toolchainReady = probe.stdout.includes('ready');
    console.log(`Workspace:   ${hasWorkspace ? chalk.green('/persist/workspace') : chalk.yellow('not created yet')}`);
    console.log(
      `Toolchain:   ${
        toolchainReady ? chalk.green('ready') : chalk.yellow('installing… (first boot pulls packages from the network)')
      }`
    );
  });

program
  .command('list')
  .alias('ls')
  .description('list all microVMs with their ports and running state')
  .option('--json', 'print raw JSON instead of a table', false)
  .action((opts: { json: boolean }) => {
    const bin = vmBinary();
    const r = spawnSync(bin, ['list'], { encoding: 'utf8' });
    if (r.status !== 0) {
      process.stderr.write(r.stderr ?? '');
      process.exit(r.status ?? 1);
    }
    if (opts.json) {
      process.stdout.write(r.stdout);
      return;
    }
    type Entry = {
      name: string;
      running: boolean;
      hostPort: number;
      apiPort: number;
      registryPort: number;
      egressPort: number;
    };
    const entries = JSON.parse(r.stdout) as Entry[];
    if (entries.length === 0) {
      console.log(chalk.dim('no microVMs defined — create one with `appliance vm up --name <name>`'));
      return;
    }
    console.log(
      `${'NAME'.padEnd(16)} ${'STATE'.padEnd(9)} ${'INGRESS'.padEnd(8)} ${'K8S'.padEnd(6)} ${'REGISTRY'.padEnd(9)} ${'EGRESS'.padEnd(7)} PROFILE`
    );
    for (const e of entries) {
      // padEnd before colorizing would miscount the ANSI codes, so pad
      // the plain text and color the already-padded cell.
      const statePad = (e.running ? 'running' : 'stopped').padEnd(9);
      const stateCell = e.running ? chalk.green(statePad) : chalk.dim(statePad);
      console.log(
        `${e.name.padEnd(16)} ${stateCell} ${String(e.hostPort).padEnd(8)} ${String(e.apiPort).padEnd(6)} ${String(e.registryPort).padEnd(9)} ${String(e.egressPort).padEnd(7)} ${profileForVm(e.name)}`
      );
    }
  });

program
  .command('doctor')
  .description('probe whether this machine can run microVMs')
  .action(() => {
    process.exit(runVm(['doctor']));
  });

// ---- egress (outbound-traffic control) ---------------------------------

const egress = program.command('egress').description("control the VM's outbound traffic (allow/deny by host)");

egress
  .command('proxy')
  .description('run the egress proxy in the foreground until killed')
  .option('--name <name>', 'VM name', DEFAULT_VM_NAME)
  .option('--addr <host:port>', 'address to listen on')
  .option('--log', 'log every allow/deny decision', false)
  .action((opts: { name: string; addr?: string; log: boolean }) => {
    const args = ['egress', 'proxy', opts.name];
    if (opts.addr) args.push('--addr', opts.addr);
    if (opts.log) args.push('--log');
    process.exit(runVm(args));
  });

egress
  .command('policy')
  .description("print the VM's current egress policy as JSON")
  .option('--name <name>', 'VM name', DEFAULT_VM_NAME)
  .action((opts: { name: string }) => {
    process.exit(runVm(['egress', 'policy', opts.name]));
  });

egress
  .command('default <action>')
  .description('set the default action when no rule matches (allow | deny)')
  .option('--name <name>', 'VM name', DEFAULT_VM_NAME)
  .action((action: string, opts: { name: string }) => {
    process.exit(runVm(['egress', 'default', action, '--name', opts.name]));
  });

egress
  .command('allow <host>')
  .description('allow outbound traffic to a host suffix (e.g. github.com)')
  .option('--name <name>', 'VM name', DEFAULT_VM_NAME)
  .action((host: string, opts: { name: string }) => {
    process.exit(runVm(['egress', 'allow', host, '--name', opts.name]));
  });

egress
  .command('deny <host>')
  .description('deny outbound traffic to a host suffix (deny wins over allow)')
  .option('--name <name>', 'VM name', DEFAULT_VM_NAME)
  .action((host: string, opts: { name: string }) => {
    process.exit(runVm(['egress', 'deny', host, '--name', opts.name]));
  });

egress
  .command('reset')
  .description('clear all rules and reset to the permissive default')
  .option('--name <name>', 'VM name', DEFAULT_VM_NAME)
  .action((opts: { name: string }) => {
    process.exit(runVm(['egress', 'reset', opts.name]));
  });

egress
  .command('mitm <state>')
  .description('enable or disable TLS interception (on | off)')
  .option('--name <name>', 'VM name', DEFAULT_VM_NAME)
  .action((state: string, opts: { name: string }) => {
    process.exit(runVm(['egress', 'mitm', state, '--name', opts.name]));
  });

egress
  .command('ca')
  .description("print the path to the VM's egress CA cert (generates on first use)")
  .option('--name <name>', 'VM name', DEFAULT_VM_NAME)
  .action((opts: { name: string }) => {
    process.exit(runVm(['egress', 'ca', opts.name]));
  });

egress
  .command('gateway')
  .description('print the HTTPS_PROXY + CA values guest workloads should use')
  .option('--name <name>', 'VM name', DEFAULT_VM_NAME)
  .action((opts: { name: string }) => {
    process.exit(runVm(['egress', 'gateway', opts.name]));
  });

egress
  .command('sync')
  .description('publish the policy into the cluster (the api-server injects it into workloads)')
  .option('--name <name>', 'VM name', DEFAULT_VM_NAME)
  .action((opts: { name: string }) => {
    process.exit(runVm(['egress', 'sync', opts.name]));
  });

egress
  .command('log')
  .description('print recorded egress traffic as JSON (the desktop traffic view feed)')
  .option('--name <name>', 'VM name', DEFAULT_VM_NAME)
  .option('--tail <n>', 'most-recent events to print', '200')
  .option('--clear', 'forget all recorded traffic instead of printing', false)
  .action((opts: { name: string; tail: string; clear: boolean }) => {
    const args = ['egress', 'log', opts.name, '--tail', opts.tail];
    if (opts.clear) args.push('--clear');
    process.exit(runVm(args));
  });

// ---- creds (per-host credential capture / injection) -------------------

const creds = program.command('creds').description('manage per-host credential capture/injection (apiKeyHelper)');

creds
  .command('list')
  .description('print credential rules + stored secrets (masked) as JSON')
  .option('--name <name>', 'VM name', DEFAULT_VM_NAME)
  .action((opts: { name: string }) => {
    process.exit(runVm(['creds', 'list', opts.name]));
  });

creds
  .command('add <host>')
  .description('add/update a per-host credential rule')
  .option('--name <name>', 'VM name', DEFAULT_VM_NAME)
  .option('--capture', 'capture the credential header off requests into the store', false)
  .option('--inject', 'inject the credential header onto outbound requests', false)
  .option('--header <header>', 'header to capture/inject (default: authorization)')
  .option('--helper <cmd>', 'command whose stdout is the credential to inject (apiKeyHelper)')
  .action(
    (host: string, opts: { name: string; capture: boolean; inject: boolean; header?: string; helper?: string }) => {
      const args = ['creds', 'add', host, '--name', opts.name];
      if (opts.capture) args.push('--capture');
      if (opts.inject) args.push('--inject');
      if (opts.header) args.push('--header', opts.header);
      if (opts.helper) args.push('--helper', opts.helper);
      process.exit(runVm(args));
    }
  );

creds
  .command('rm <host>')
  .description("remove a host's credential rule")
  .option('--name <name>', 'VM name', DEFAULT_VM_NAME)
  .action((host: string, opts: { name: string }) => {
    process.exit(runVm(['creds', 'rm', host, '--name', opts.name]));
  });

creds
  .command('set <host> <value>')
  .description('manually store a secret for a host (e.g. paste an API key)')
  .option('--name <name>', 'VM name', DEFAULT_VM_NAME)
  .option('--header <header>', 'header the secret is for (default: authorization)')
  .action((host: string, value: string, opts: { name: string; header?: string }) => {
    const args = ['creds', 'set', host, value, '--name', opts.name];
    if (opts.header) args.push('--header', opts.header);
    process.exit(runVm(args));
  });

creds
  .command('forget')
  .description('forget all stored secrets (rules are kept)')
  .option('--name <name>', 'VM name', DEFAULT_VM_NAME)
  .action((opts: { name: string }) => {
    process.exit(runVm(['creds', 'forget', opts.name]));
  });

program.parse(process.argv);
