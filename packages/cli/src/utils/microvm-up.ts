import chalk from 'chalk';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  bootstrapInClusterApiServer,
  ensureDockerRunning,
  kubectlApplyManifest,
  readExistingBootstrapToken,
  renderInClusterApiServerManifest,
  resolveRuntimeConfig,
  waitForApiServerUrl,
  apiServerUrlForHostPort,
} from '@appliance.sh/helper';
import type { ProgressEvent } from '@appliance.sh/helper';
import { createApplianceClient, VERSION } from '@appliance.sh/sdk';
import { saveCredentials } from './credentials.js';
import { readProfiles, removeProfile } from './profile-store.js';

// Shared microVM bring-up core.
//
// `runUp` boots the microVM, waits for its kubernetes endpoint + in-VM
// registry, delivers + bootstraps the in-VM api-server, and adopts the
// VM's credential profile. It is the single orchestration both
// `appliance vm up` (the lower-level multi-VM command) and
// `appliance init` (the one-tap onboarding front door) call, so the two
// can never drift. The lower-level VM primitives it leans on — binary
// resolution, the spec-derived ports, the per-VM profile name — live
// here too so `appliance-vm.ts` and `appliance-init.ts` share one copy.
//
// The heavy lifting lives in the `appliance-vm` Rust binary; this drives
// it and layers the Appliance control plane on top (in-VM api-server
// bootstrap + credential registration).

export const DEFAULT_VM_NAME = 'appliance';

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
export function profileForVm(name: string): string {
  return name === DEFAULT_VM_NAME ? 'microvm' : `microvm-${name}`;
}

export function vmDir(name: string): string {
  return path.join(os.homedir(), '.appliance', 'vm', name);
}

/** Read a VM's forwarded host ports from its persisted spec, falling
 *  back to the canonical defaults when the spec isn't written yet.
 *  Module-private: only `runUp` below consumes it. */
function vmPorts(name: string): {
  hostPort: number;
  apiPort: number;
  registryPort: number;
  egressPort: number;
} {
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

/** Resolve the appliance-vm binary that `runVm` would invoke, or null
 *  when none is runnable. Resolution order: explicit override → managed
 *  install → PATH → the repo build. The desktop installs into
 *  ~/.appliance/bin (and the npm distribution ships per-platform
 *  binaries); the repo paths keep `pnpm`-checkout workflows working.
 *  Returns the path without exiting so callers that only want to inspect
 *  the binary (e.g. the dev-signing preflight) can probe it safely. */
export function resolveVmBinary(): string | null {
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
  return null;
}

export function vmBinary(): string {
  const bin = resolveVmBinary();
  if (bin) return bin;
  console.error(
    chalk.red(
      'appliance-vm binary not found. Build it with `cargo build && ./scripts/sign-dev.sh` in packages/vm, or set APPLIANCE_VM.'
    )
  );
  process.exit(1);
}

export function runVm(args: string[]): number {
  const bin = vmBinary();
  const r = spawnSync(bin, args, { stdio: 'inherit' });
  return r.status ?? 1;
}

// Deleting a microVM is not a plain engine passthrough. The Rust engine
// removes the VM and its on-disk state, but the credential profile that
// `vm up` minted (`microvm` for the default VM, `microvm-<name>`
// otherwise) lives in the CLI profile store — which the engine knows
// nothing about. Without pruning it, a deleted VM leaves an orphan
// cluster behind in both the CLI and the desktop (both read
// ~/.appliance/profiles.json). So both `appliance vm delete` and
// `appliance cluster rm --delete-vm` route through this one helper.

/** Delete a microVM via the engine, then prune its CLI credential
 *  profile. The profile is only removed once the engine confirms the VM
 *  is gone (exit 0), so a failed delete never strips a usable profile.
 *  Returns the engine's exit code. */
export function deleteVmAndProfile(name: string): number {
  const code = runVm(['delete', name]);
  if (code === 0) {
    const profile = profileForVm(name);
    if (removeProfile(profile)) {
      console.log(chalk.dim(`removed credential profile '${profile}'`));
    }
  }
  return code;
}

// Module-private: only this file's bring-up steps render progress events.
const printProgress = (event: ProgressEvent) => {
  const prefix = event.type === 'error' ? chalk.red('✗') : event.type === 'done' ? chalk.green('✓') : chalk.cyan('»');
  console.log(`${prefix} ${chalk.dim(event.tool)} ${event.message}`);
};

export async function runUp(
  name: string,
  imageOverride: string | undefined,
  timeout: number,
  resources: { cpus?: number; memory?: number; dev?: boolean; mount?: string } = {},
  // `showDeployHint` controls the banner's closing `Deploy:` line.
  // `appliance vm up` leaves it on; `appliance init` suppresses it so its
  // own hand-off prints the single, unambiguous next command.
  opts: { showDeployHint?: boolean } = {}
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
  if (status !== 0) {
    console.error(
      chalk.dim(
        'Tip: for local deploys without a VM, `appliance server start` runs the control plane as a host daemon (needs only Docker).'
      )
    );
    process.exit(status);
  }
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
    // Credentials survive, but the delivered image only lands in the
    // registry — re-apply the manifests so a changed digest (a fresh
    // `--image`, or a newer published build) actually rolls the
    // Deployment. Deploy-by-digest makes this a no-op when unchanged.
    const token = await readExistingBootstrapToken({ kubeconfigPath });
    if (token) {
      const cfg = await resolveRuntimeConfig(runtime);
      await kubectlApplyManifest(renderInClusterApiServerManifest(cfg, vmImage, token), { kubeconfigPath });
      console.log(chalk.dim(`api-server manifests reconciled (image ${vmImage})`));
    }
  } else {
    // The bootstrap applies its manifests with kubectl. Auto-install it
    // like crane above — a fresh machine shouldn't fail the bring-up
    // over a tool the helper knows how to provision.
    await ensureKubectl();
    const result = await bootstrapInClusterApiServer({
      runtime,
      image: vmImage,
      kubeconfigPath,
      keyName: name === DEFAULT_VM_NAME ? 'MicroVM Runtime' : `MicroVM Runtime (${name})`,
      onProgress: printProgress,
      // First boot pulls + unpacks the multi-GB api-server image from
      // the in-VM registry into containerd before the pod can start —
      // the default 240s readiness budget is calibrated for re-applies,
      // not that cold path.
      readyTimeoutMs: 600_000,
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
  if (opts.showDeployHint ?? true) {
    console.log(`  Deploy:      appliance deploy <project> <environment> --profile ${profile}`);
  }
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
          'and run `appliance doctor` to confirm the host prerequisites (Docker, free ports) are healthy.\n' +
          'Or skip the VM entirely: `appliance server start` runs the control plane as a lightweight host daemon.'
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

  // Auto-pull the pinned published image whenever nothing local can serve
  // the VM's architecture — either nothing is present at all, or every
  // local build is the wrong arch. The amd64 Lambda default (what
  // docker-prep.sh + `docker build` produce by default) is the common
  // culprit on Apple Silicon: as a present-but-wrong-arch candidate it
  // used to mask this fallback and hard-fail the bring-up. Gating on the
  // arch instead of mere presence lets `vm up` self-heal. Mirrors the
  // bootstrap default (phases/phase2.ts) — the same versioned ghcr ref
  // every surface uses. Skipped when the caller pinned --image: honor
  // their exact ref and let the arch check below explain any mismatch
  // rather than silently substituting a different image.
  const hasHostArch = present.some((c) => c.arch === VM_HOST_ARCH);
  if (!hasHostArch && !imageOverride) {
    const pulled = pullPublishedApiServer();
    // Prepend so the freshly-pulled host-arch image is tried first; keep
    // any wrong-arch locals for the diagnostic if the pull also fails.
    if (pulled) present = [pulled, ...present];
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
  console.log(chalk.cyan(`» no local api-server image for linux/${VM_HOST_ARCH} — pulling ${ref}`));
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

async function ensureKubectl(): Promise<void> {
  const { runInstall } = await import('@appliance.sh/helper');
  const outcomes = await runInstall({ tools: ['kubectl'], onProgress: printProgress });
  const failed = outcomes.find((o) => o.status === 'failed');
  if (failed) throw new Error(`kubectl install failed: ${failed.message}`);
}

async function ensureCrane(): Promise<string> {
  const { runInstall, helperBinDir } = await import('@appliance.sh/helper');
  const outcomes = await runInstall({ tools: ['crane'], onProgress: printProgress });
  const failed = outcomes.find((o) => o.status === 'failed');
  if (failed) throw new Error(`crane install failed: ${failed.message}`);
  const managed = path.join(helperBinDir(), process.platform === 'win32' ? 'crane.exe' : 'crane');
  return fs.existsSync(managed) ? managed : 'crane';
}
