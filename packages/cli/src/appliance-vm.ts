import { Command } from 'commander';
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
import { createApplianceClient } from '@appliance.sh/sdk';
import { saveCredentials } from './utils/credentials.js';
import { readProfiles } from './utils/profile-store.js';

// `appliance vm` — the microVM runtime engine (appliance-vm). Same
// developer surface as `appliance local` (the k3d engine), but the
// workloads run inside an isolated VM that Appliance itself boots:
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

const MICROVM_PROFILE = 'microvm';
const DEFAULT_VM_NAME = 'appliance';
const VM_HOST_PORT = 8081;
const VM_REGISTRY_PORT = 5052;
// Mirrors VmSpec defaults in packages/vm/src/spec.rs — keep in sync.

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
  .action(async (opts: { name: string; image?: string; timeout: string }) => {
    try {
      await runUp(opts.name, opts.image, Number.parseInt(opts.timeout, 10));
    } catch (err) {
      console.error(chalk.red(err instanceof Error ? err.message : String(err)));
      process.exit(1);
    }
  });

async function runUp(name: string, imageOverride: string | undefined, timeout: number): Promise<void> {
  // 1. Boot the VM + wait for its kubernetes endpoint.
  const status = runVm(['up', name, '--timeout', String(timeout)]);
  if (status !== 0) process.exit(status);
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
  await waitForRegistry(`http://127.0.0.1:${VM_REGISTRY_PORT}/v2/`, 240_000);

  // 3. Deliver the api-server image. The image must be present in the
  //    local docker daemon (built via packages/api-server's
  //    docker-prep.sh); docker is needed for image *builds* anyway —
  //    the cluster itself no longer depends on it.
  const image = imageOverride ?? (await resolveApiServerImage());
  await ensureDockerRunning({ onProgress: printProgress });
  console.log(chalk.cyan(`» pushing ${image} into the VM registry`));
  // Deploy by digest: pushing a different image under a reused tag
  // would leave the Deployment spec unchanged (no rollout) and
  // IfNotPresent would keep serving the stale cached image.
  const vmImage = await pushImageHostSide(image, `localhost:${VM_REGISTRY_PORT}/appliance-api-server:latest`);

  // 4. In-VM api-server: same shared bootstrap as the k3d engine,
  //    pointed at the VM's kubeconfig and registry.
  const existing = readProfiles().profiles[MICROVM_PROFILE];
  const apiServerUrl = apiServerUrlForHostPort(VM_HOST_PORT);
  const runtime = {
    dataDir: '/persist/appliance-data',
    hostPort: VM_HOST_PORT,
    registryUrl: `localhost:${VM_REGISTRY_PORT}`,
  };
  let verified = false;
  if (existing) {
    // Reconcile manifests, then keep existing credentials when they
    // still authenticate — same no-key-sprawl behavior as
    // `appliance local up`.
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
    console.log(
      `${chalk.green('✓')} api-server reachable; profile ${chalk.bold(MICROVM_PROFILE)} already authenticated`
    );
  } else {
    const result = await bootstrapInClusterApiServer({
      runtime,
      image: vmImage,
      kubeconfigPath,
      keyName: 'MicroVM Runtime',
      onProgress: printProgress,
    });
    saveCredentials(
      { apiUrl: result.apiServerUrl, keyId: result.apiKey.id, secret: result.apiKey.secret },
      MICROVM_PROFILE
    );
    console.log(
      `${chalk.green('✓')} api-server bootstrapped; credentials saved to profile ${chalk.bold(MICROVM_PROFILE)}`
    );
  }

  // Publish the egress policy into the cluster now that the namespace
  // exists, so the api-server can confine workloads per policy. Best-
  // effort: a permissive default policy is a harmless no-op.
  runVm(['egress', 'sync', name]);

  console.log();
  console.log(chalk.green('MicroVM runtime is up.'));
  console.log(`  API server:  ${apiServerUrl}`);
  console.log(`  Profile:     ${MICROVM_PROFILE}`);
  console.log(`  Deploy:      appliance deploy <project> <environment> --profile ${MICROVM_PROFILE}`);
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
      throw new Error(`in-VM registry not reachable at ${url} — check \`appliance vm console\``);
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}

/**
 * Pick a locally built api-server image whose architecture matches
 * the VM (= the host: Virtualization.framework doesn't emulate, so an
 * amd64 image on Apple Silicon crashloops with `exec format error`).
 * Tries the arch-suffixed tag first, then validates :latest.
 */
async function resolveApiServerImage(): Promise<string> {
  await ensureDockerRunning({ onProgress: printProgress });
  const hostArch = process.arch === 'arm64' ? 'arm64' : 'amd64';
  for (const candidate of [`appliance-api-server:${hostArch}`, 'appliance-api-server:latest']) {
    const r = spawnSync('docker', ['image', 'inspect', '--format', '{{.Architecture}}', candidate], {
      encoding: 'utf8',
    });
    if (r.status !== 0) continue;
    const arch = r.stdout.trim();
    if (arch === hostArch) return candidate;
    console.log(
      chalk.dim(
        `${candidate} is ${arch}, VM needs ${hostArch} — ${candidate === 'appliance-api-server:latest' ? 'skipping' : 'trying next'}`
      )
    );
  }
  throw new Error(
    `no ${hostArch} appliance-api-server image found. Build one with:\n` +
      `  cd packages/api-server && docker build --platform linux/${hostArch} -t appliance-api-server:${hostArch} .\n` +
      '(docker-prep.sh stages the build context; its default image targets Lambda/amd64.) Or pass --image <ref>.'
  );
}

function dockerOrThrow(args: string[]): void {
  const r = spawnSync('docker', args, { stdio: 'inherit' });
  if (r.status !== 0) {
    throw new Error(`docker ${args.join(' ')} failed`);
  }
}

/**
 * Deliver a daemon-held image to a host-loopback registry from the
 * host process: `docker save` + `crane push`. A plain `docker push`
 * executes inside the docker VM (colima/Docker Desktop), where the
 * host's 127.0.0.1 — and therefore the microVM's forwarded registry —
 * doesn't exist.
 */
async function pushImageHostSide(image: string, targetRef: string): Promise<string> {
  const crane = await ensureCrane();
  const tarPath = path.join(os.tmpdir(), `appliance-image-${process.pid}.tar`);
  try {
    dockerOrThrow(['save', '-o', tarPath, image]);
    const r = spawnSync(crane, ['push', '--insecure', tarPath, targetRef], {
      stdio: ['ignore', 'pipe', 'inherit'],
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
    if (r.status !== 0) throw new Error(`crane push to ${targetRef} failed`);
    // crane prints the digest-qualified reference as its final stdout
    // line — the immutable ref we hand to the deployment.
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
  } finally {
    fs.rmSync(tarPath, { force: true });
  }
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
  ['delete', 'delete the microVM and its state'],
] as const) {
  program
    .command(cmd)
    .description(desc)
    .option('--name <name>', 'VM name', DEFAULT_VM_NAME)
    .action((opts: { name: string }) => {
      process.exit(runVm([cmd, opts.name]));
    });
}

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

program
  .command('shell')
  .description('open a root shell inside the VM itself (or run one command: appliance vm shell -- uname -a)')
  .option('--name <name>', 'VM name', DEFAULT_VM_NAME)
  .argument('[command...]', 'command to run instead of an interactive shell')
  .action((command: string[], opts: { name: string }) => {
    const kubeconfig = kubeconfigOrExit(opts.name);
    const node = spawnSync(
      'kubectl',
      ['--kubeconfig', kubeconfig, 'get', 'nodes', '-o', 'jsonpath={.items[0].metadata.name}'],
      { encoding: 'utf8' }
    );
    const nodeName = node.status === 0 ? node.stdout.trim() : '';
    if (!nodeName) {
      console.error(chalk.red('could not resolve the VM node — is the VM up? (appliance vm up)'));
      process.exit(1);
    }
    // `kubectl debug node/` attaches a pod with the VM's root fs at
    // /host; chroot turns it into a real VM shell. No SSH or guest
    // agent needed — it rides the same kubeconfig as everything else.
    // --profile=sysadmin grants privileged + hostPID/hostNetwork.
    // One-shot commands go through `sh -c` (attach streams reliably);
    // no command means an interactive shell.
    const entry = command.length ? ['/bin/sh', '-c', command.join(' ')] : ['/bin/sh'];
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
    // kubectl debug leaves its debugger pod behind by design; sweep
    // ours so repeated shells don't accumulate Completed pods.
    cleanupNodeDebuggerPods(kubeconfig, nodeName);
    process.exit(r.status ?? 1);
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

program.parse(process.argv);
