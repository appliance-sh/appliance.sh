import { execFile, spawn } from 'node:child_process';
import { Writable } from 'node:stream';
import { ApplianceBaseType, isDockerBase, getDockerParams, Workloads } from '@appliance.sh/sdk';
import type { ApplianceBaseConfig } from '@appliance.sh/sdk';
import type {
  DeploymentHealth,
  LocalDeploymentMetadata,
  LocalDeploymentResult,
  LocalResolvedBuild,
  PodHealth,
} from '../local/LocalContainerDeploymentService';

// Labels stamped on every managed container. `managed` scopes list
// queries to appliance-owned containers; `stack` is the analogue of
// the k8s path's `app.kubernetes.io/name` selector; `env`/`port`
// persist the deploy-time inputs so a bare redeploy (no build, no env
// override) can preserve them — the same contract getDeploymentEnv
// serves on the Kubernetes backend.
const LABEL_MANAGED = 'sh.appliance.managed';
const LABEL_STACK = 'sh.appliance.stack';
const LABEL_PROJECT = 'sh.appliance.project';
const LABEL_ENVIRONMENT = 'sh.appliance.environment';
const LABEL_DEPLOYMENT_ID = 'sh.appliance.deployment-id';
const LABEL_PROJECT_ID = 'sh.appliance.project-id';
const LABEL_ENVIRONMENT_ID = 'sh.appliance.environment-id';
const LABEL_ENV_JSON = 'sh.appliance.env';
const LABEL_PORT = 'sh.appliance.port';

// Host-port window deploys draw from (overridable via
// `base.docker.portRange`). Deliberately distinct from the sandbox
// VM's 8100-8999 guest window and the k8s NodePort window so a URL's
// port telegraphs which runtime is serving it.
export const DEFAULT_DOCKER_PORT_MIN = 8300;
export const DEFAULT_DOCKER_PORT_MAX = 8699;

// How long a freshly-run container gets to reach a stable Running
// state before the deploy is reported as failed. Docker containers
// start in milliseconds; the budget mostly covers slow entrypoints.
const START_TIMEOUT_MS = 30_000;
const START_POLL_INTERVAL_MS = 500;

/** Minimal exec abstraction so tests can fake the docker CLI. */
export type DockerExec = (args: string[]) => Promise<{ stdout: string; stderr: string }>;

/**
 * The method surface the api-server consumes from a container-runtime
 * deploy backend. `KubernetesDeploymentService` satisfies it
 * structurally; `DockerDeploymentService` implements it against a
 * plain Docker daemon. Keep this in sync with the executor's
 * `executeLocalAction` plus the health/workloads services.
 */
export interface ContainerDeploymentBackend {
  deploy(
    stackName: string,
    metadata: LocalDeploymentMetadata,
    build: LocalResolvedBuild
  ): Promise<LocalDeploymentResult>;
  destroy(stackName: string): Promise<LocalDeploymentResult>;
  refresh(stackName: string): Promise<LocalDeploymentResult>;
  getDeploymentImage(stackName: string): Promise<string | undefined>;
  getDeploymentEnv(stackName: string): Promise<Record<string, string> | undefined>;
  getDeploymentHealth(stackName: string): Promise<DeploymentHealth>;
  listWorkloads(opts?: { namespace?: string; labelSelector?: string }): Promise<Workloads>;
  getPodLogs(
    podName: string,
    opts?: { container?: string; tailLines?: number; namespace?: string; sinceSeconds?: number }
  ): Promise<string>;
  streamPodLogs(
    podName: string,
    destination: Writable,
    opts?: { container?: string; tailLines?: number; namespace?: string; sinceSeconds?: number }
  ): Promise<AbortController>;
}

/** The slice of `docker inspect` output this service reads. */
interface InspectedContainer {
  name: string;
  image: string;
  running: boolean;
  status: string; // created | running | paused | restarting | exited | dead
  exitCode: number;
  restartCount: number;
  startedAt?: string;
  createdAt?: string;
  healthStatus?: string; // starting | healthy | unhealthy
  labels: Record<string, string>;
  /** First published host port, when any. */
  hostPort?: number;
  /** Container-side port of that binding. */
  containerPort?: number;
}

/**
 * Drives appliance deploys against a plain Docker daemon — the
 * `appliance-base-docker` runtime behind the single-binary local
 * server. Each stack maps to ONE container named
 * `appliance-<stackName>` with a published host port; deploy recreates
 * the container, destroy removes it. No cluster, no registry, no
 * manifests: the image is whatever the local daemon already holds
 * (the CLI builds it there), referenced by tag or immutable image ID.
 *
 * Scale semantics: docker bases run a single container per stack.
 * A requested `replicas > 1` is not an error — the deploy proceeds
 * and the result message says the knob was ignored (matching how
 * Lambda bases treat it). Horizontal scale is what the Kubernetes
 * and cloud bases are for.
 *
 * Shells out to the `docker` CLI (array-args execFile, no shell)
 * rather than a daemon-socket client library: the daemon runs where
 * docker is already a build-time requirement, and the CLI honours
 * DOCKER_HOST / contexts for free.
 */
export class DockerDeploymentService implements ContainerDeploymentBackend {
  private readonly portMin: number;
  private readonly portMax: number;
  private readonly exec: DockerExec;

  constructor(baseConfig: ApplianceBaseConfig, exec?: DockerExec) {
    if (!isDockerBase(baseConfig)) {
      throw new Error(
        `DockerDeploymentService requires a '${ApplianceBaseType.ApplianceDocker}' base config; got '${baseConfig.type}'`
      );
    }
    const params = getDockerParams(baseConfig);
    this.portMin = params?.portRange?.min ?? DEFAULT_DOCKER_PORT_MIN;
    this.portMax = params?.portRange?.max ?? DEFAULT_DOCKER_PORT_MAX;
    const dockerHost = params?.host;
    this.exec =
      exec ??
      ((args: string[]) =>
        new Promise((resolve, reject) => {
          execFile(
            'docker',
            args,
            {
              encoding: 'utf8',
              maxBuffer: 16 * 1024 * 1024,
              env: dockerHost ? { ...process.env, DOCKER_HOST: dockerHost } : process.env,
            },
            (error, stdout, stderr) => {
              if (error) {
                reject(new Error(stderr?.trim() || error.message));
                return;
              }
              resolve({ stdout, stderr });
            }
          );
        }));
  }

  async deploy(
    stackName: string,
    metadata: LocalDeploymentMetadata,
    build: LocalResolvedBuild
  ): Promise<LocalDeploymentResult> {
    const containerName = containerNameFor(stackName);
    const image = build.imageUri;
    const port = build.port ?? 8080;
    const env = build.environment ?? {};
    const existing = await this.inspectContainer(containerName);

    // True no-op: same image, same env, same port, and the container
    // is actually running — nothing to recreate. (The k8s path
    // re-applies its manifest and reports noop on image match alone;
    // here recreation restarts the process, so we only skip when the
    // full deploy-time input is unchanged.)
    const unchanged =
      existing !== null &&
      existing.running &&
      existing.image === image &&
      (existing.labels[LABEL_ENV_JSON] ?? '{}') === JSON.stringify(env) &&
      existing.labels[LABEL_PORT] === String(port);
    if (unchanged) {
      const url = urlForHostPort(existing.hostPort);
      return {
        action: 'deploy',
        ok: true,
        idempotentNoop: true,
        message: 'No changes (idempotent)',
        stackName,
        ...(url ? { url } : {}),
      };
    }

    // Keep the stack's host port stable across redeploys: reuse the
    // live container's binding, else derive a deterministic one.
    const desiredHostPort = existing?.hostPort ?? this.deterministicHostPort(stackName);

    if (existing) {
      await this.removeContainer(containerName);
    }

    const runArgs = (publish: string) => [
      'run',
      '--detach',
      '--name',
      containerName,
      '--restart',
      'unless-stopped',
      '--publish',
      publish,
      '--label',
      `${LABEL_MANAGED}=true`,
      '--label',
      `${LABEL_STACK}=${stackName}`,
      '--label',
      `${LABEL_PROJECT}=${metadata.projectName}`,
      '--label',
      `${LABEL_ENVIRONMENT}=${metadata.environmentName}`,
      '--label',
      `${LABEL_DEPLOYMENT_ID}=${metadata.deploymentId}`,
      '--label',
      `${LABEL_PROJECT_ID}=${metadata.projectId}`,
      '--label',
      `${LABEL_ENVIRONMENT_ID}=${metadata.environmentId}`,
      '--label',
      `${LABEL_ENV_JSON}=${JSON.stringify(env)}`,
      '--label',
      `${LABEL_PORT}=${port}`,
      ...Object.entries(env).flatMap(([k, v]) => ['--env', `${k}=${v}`]),
      image,
    ];

    try {
      await this.exec(runArgs(`${desiredHostPort}:${port}`));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!/port is already allocated|address already in use|bind/i.test(message)) {
        throw new Error(`docker run failed for ${stackName}: ${message}`);
      }
      // Deterministic port collided with something outside our
      // control — let the daemon pick a free ephemeral port instead
      // of failing the deploy. A container-port-only publish
      // (`--publish <port>`) maps it to a random host port.
      await this.removeContainer(containerName);
      await this.exec(runArgs(String(port)));
    }

    await this.waitForRunning(containerName);
    const live = await this.inspectContainer(containerName);
    const url = urlForHostPort(live?.hostPort ?? desiredHostPort);

    const replicasNote =
      build.replicas !== undefined && build.replicas > 1
        ? ` (replicas: docker bases run a single container — requested ${build.replicas} ignored)`
        : '';
    return {
      action: 'deploy',
      ok: true,
      idempotentNoop: false,
      message: `Stack updated. URL: ${url}${replicasNote}`,
      stackName,
      url,
    };
  }

  async destroy(stackName: string): Promise<LocalDeploymentResult> {
    const containerName = containerNameFor(stackName);
    const existing = await this.inspectContainer(containerName);
    if (existing) {
      await this.removeContainer(containerName);
    }
    return {
      action: 'destroy',
      ok: true,
      idempotentNoop: existing === null,
      message: existing ? `Container ${containerName} removed` : 'Stack not found (idempotent)',
      stackName,
    };
  }

  async refresh(stackName: string): Promise<LocalDeploymentResult> {
    // As on the Kubernetes backend: the daemon's live state IS the
    // source of truth, so refresh settles as a no-op.
    const exists = (await this.inspectContainer(containerNameFor(stackName))) !== null;
    return {
      action: 'refresh',
      ok: true,
      idempotentNoop: true,
      message: exists ? 'Docker stacks have no separate state to refresh' : 'Stack not found (nothing to refresh)',
      stackName,
    };
  }

  async getDeploymentImage(stackName: string): Promise<string | undefined> {
    const c = await this.inspectContainer(containerNameFor(stackName));
    return c?.image;
  }

  async getDeploymentEnv(stackName: string): Promise<Record<string, string> | undefined> {
    const c = await this.inspectContainer(containerNameFor(stackName));
    if (!c) return undefined;
    return parseEnvLabel(c.labels[LABEL_ENV_JSON]);
  }

  async getDeploymentHealth(stackName: string): Promise<DeploymentHealth> {
    const c = await this.inspectContainer(containerNameFor(stackName));
    if (!c) {
      return { deployed: false, desiredReplicas: 0, readyReplicas: 0, restarts: 0, pods: [] };
    }
    const pod = podHealthOf(c);
    return {
      deployed: true,
      desiredReplicas: 1,
      readyReplicas: pod.ready ? 1 : 0,
      restarts: pod.restarts,
      pods: [pod],
    };
  }

  /**
   * List managed containers as the Workloads triple the console
   * renders. Each container surfaces as one Deployment row (its
   * stack), one Pod row (the container), and one Service row (its
   * host-port publish) so the k8s-shaped UI carries over unchanged.
   * The only selector the callers use is
   * `app.kubernetes.io/name=<stackName>` — mapped onto the stack
   * label here.
   */
  async listWorkloads(opts?: { namespace?: string; labelSelector?: string }): Promise<Workloads> {
    const filters = ['--filter', `label=${LABEL_MANAGED}=true`];
    const selector = opts?.labelSelector;
    if (selector) {
      const match = /^app\.kubernetes\.io\/name=(.+)$/.exec(selector.trim());
      if (!match) {
        throw new Error(`Unsupported label selector for docker bases: '${selector}'`);
      }
      filters.push('--filter', `label=${LABEL_STACK}=${match[1]}`);
    }
    const { stdout } = await this.exec(['ps', '--all', ...filters, '--format', '{{.ID}}']);
    const ids = stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    if (ids.length === 0) return { deployments: [], pods: [], services: [] };

    const containers = await this.inspectMany(ids);
    const workloads: Workloads = { deployments: [], pods: [], services: [] };
    for (const c of containers) {
      const stack = c.labels[LABEL_STACK] ?? c.name;
      const pod = podHealthOf(c);
      workloads.deployments.push({
        name: stack,
        image: c.image,
        desired: 1,
        ready: pod.ready ? 1 : 0,
        available: c.running ? 1 : 0,
        ...(c.createdAt ? { createdAt: c.createdAt } : {}),
      });
      workloads.pods.push({
        name: c.name,
        phase: pod.phase,
        ready: pod.ready,
        restartCount: pod.restarts,
        containerImage: c.image,
        ...(c.createdAt ? { createdAt: c.createdAt } : {}),
      });
      workloads.services.push({
        name: stack,
        serviceType: 'HostPort',
        ...(c.hostPort !== undefined ? { nodePort: c.hostPort } : {}),
        ...(c.containerPort !== undefined ? { targetPort: c.containerPort } : {}),
      });
    }
    return workloads;
  }

  /** Snapshot container logs. `podName` is the container name the
   *  workloads listing reported (`appliance-<stackName>`). */
  async getPodLogs(
    podName: string,
    opts?: { container?: string; tailLines?: number; namespace?: string; sinceSeconds?: number }
  ): Promise<string> {
    const args = ['logs'];
    if (opts?.tailLines !== undefined) args.push('--tail', String(opts.tailLines));
    if (opts?.sinceSeconds !== undefined) args.push('--since', `${opts.sinceSeconds}s`);
    args.push(podName);
    const { stdout, stderr } = await this.exec(args);
    // Docker splits the container's stdout/stderr across the CLI's
    // two streams; the caller wants one text blob like `kubectl logs`.
    return stderr ? `${stdout}${stdout && !stdout.endsWith('\n') ? '\n' : ''}${stderr}` : stdout;
  }

  /**
   * Follow container logs, piping both output streams into
   * `destination`. Returns the AbortController bound to the child
   * `docker logs -f`; aborting it (or the child exiting) tears the
   * stream down.
   */
  async streamPodLogs(
    podName: string,
    destination: Writable,
    opts?: { container?: string; tailLines?: number; namespace?: string; sinceSeconds?: number }
  ): Promise<AbortController> {
    const args = ['logs', '--follow'];
    if (opts?.tailLines !== undefined) args.push('--tail', String(opts.tailLines));
    if (opts?.sinceSeconds !== undefined) args.push('--since', `${opts.sinceSeconds}s`);
    args.push(podName);

    const controller = new AbortController();
    const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'], signal: controller.signal });
    child.stdout.pipe(destination, { end: false });
    child.stderr.pipe(destination, { end: false });
    child.on('close', () => destination.end());
    child.on('error', () => destination.end());
    return controller;
  }

  /** Hash the stack name into [portMin, portMax] — same scheme as the
   *  k8s backend's deterministicNodePort so URLs stay stable across
   *  redeploys without a port-registry. */
  deterministicHostPort(stackName: string): number {
    const range = this.portMax - this.portMin + 1;
    let hash = 0;
    for (let i = 0; i < stackName.length; i++) {
      hash = (hash * 31 + stackName.charCodeAt(i)) | 0;
    }
    return this.portMin + (Math.abs(hash) % range);
  }

  private async removeContainer(containerName: string): Promise<void> {
    try {
      await this.exec(['rm', '--force', containerName]);
    } catch (err) {
      if (isNoSuchContainer(err)) return;
      throw err;
    }
  }

  /**
   * Poll until the container reports Running (and its healthcheck, if
   * it declares one, stops reporting `starting`), or fail with the
   * container's log tail when it exits — a crashed entrypoint should
   * surface its own error, not a bare timeout.
   */
  private async waitForRunning(containerName: string): Promise<void> {
    const deadline = Date.now() + START_TIMEOUT_MS;
    for (;;) {
      const c = await this.inspectContainer(containerName);
      if (!c) throw new Error(`container ${containerName} disappeared while starting`);
      if (c.status === 'exited' || c.status === 'dead') {
        const tail = await this.logTail(containerName);
        throw new Error(
          `container ${containerName} exited with code ${c.exitCode} during startup.` + (tail ? `\n${tail}` : '')
        );
      }
      const healthPending = c.healthStatus === 'starting';
      if (c.running && !healthPending) {
        if (c.healthStatus === 'unhealthy') {
          const tail = await this.logTail(containerName);
          throw new Error(`container ${containerName} reports unhealthy.` + (tail ? `\n${tail}` : ''));
        }
        return;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `container ${containerName} did not reach a running state within ${Math.floor(START_TIMEOUT_MS / 1000)}s`
        );
      }
      await sleep(START_POLL_INTERVAL_MS);
    }
  }

  private async logTail(containerName: string): Promise<string> {
    try {
      const { stdout, stderr } = await this.exec(['logs', '--tail', '20', containerName]);
      return `${stdout}${stderr}`.trim();
    } catch {
      return '';
    }
  }

  private async inspectContainer(containerName: string): Promise<InspectedContainer | null> {
    const all = await this.inspectMany([containerName]);
    return all[0] ?? null;
  }

  private async inspectMany(refs: string[]): Promise<InspectedContainer[]> {
    let stdout: string;
    try {
      ({ stdout } = await this.exec(['inspect', ...refs]));
    } catch (err) {
      if (isNoSuchContainer(err)) {
        // Mixed hit/miss inspect exits non-zero but still prints the
        // hits — re-run one by one only when several refs were asked.
        if (refs.length > 1) {
          const results = await Promise.all(refs.map((r) => this.inspectMany([r])));
          return results.flat();
        }
        return [];
      }
      throw err;
    }
    const parsed = JSON.parse(stdout) as RawInspect[];
    return parsed.map(toInspectedContainer);
  }
}

/** Raw `docker inspect` JSON, narrowed to the fields consumed here. */
interface RawInspect {
  Name?: string;
  Created?: string;
  Config?: { Image?: string; Labels?: Record<string, string> | null };
  State?: {
    Status?: string;
    Running?: boolean;
    ExitCode?: number;
    StartedAt?: string;
    Health?: { Status?: string };
  };
  RestartCount?: number;
  NetworkSettings?: {
    Ports?: Record<string, Array<{ HostIp?: string; HostPort?: string }> | null>;
  };
  HostConfig?: {
    PortBindings?: Record<string, Array<{ HostIp?: string; HostPort?: string }> | null>;
  };
}

function toInspectedContainer(raw: RawInspect): InspectedContainer {
  // Live containers report bindings under NetworkSettings.Ports;
  // stopped ones only keep the requested HostConfig.PortBindings.
  const portMaps = { ...(raw.HostConfig?.PortBindings ?? {}), ...(raw.NetworkSettings?.Ports ?? {}) };
  let hostPort: number | undefined;
  let containerPort: number | undefined;
  for (const [key, bindings] of Object.entries(portMaps)) {
    const first = bindings?.[0];
    const parsedHost = first?.HostPort ? Number.parseInt(first.HostPort, 10) : NaN;
    if (Number.isFinite(parsedHost) && parsedHost > 0) {
      hostPort = parsedHost;
      const parsedContainer = Number.parseInt(key, 10); // "8080/tcp"
      containerPort = Number.isFinite(parsedContainer) ? parsedContainer : undefined;
      break;
    }
  }
  return {
    name: (raw.Name ?? '').replace(/^\//, ''),
    image: raw.Config?.Image ?? '',
    running: raw.State?.Running === true,
    status: raw.State?.Status ?? 'unknown',
    exitCode: raw.State?.ExitCode ?? 0,
    restartCount: raw.RestartCount ?? 0,
    startedAt: raw.State?.StartedAt,
    createdAt: raw.Created,
    healthStatus: raw.State?.Health?.Status,
    labels: raw.Config?.Labels ?? {},
    hostPort,
    containerPort,
  };
}

/** Container readiness collapsed into the k8s-shaped PodHealth the
 *  console renders. Phase mirrors pod phases loosely: running →
 *  Running, created → Pending, exited/dead → the docker status
 *  (capitalised) with the exit code as the reason. */
function podHealthOf(c: InspectedContainer): PodHealth {
  const phase =
    c.status === 'running' || c.status === 'restarting'
      ? 'Running'
      : c.status === 'created'
        ? 'Pending'
        : capitalize(c.status);
  const ready =
    c.running && c.healthStatus !== 'unhealthy' && c.healthStatus !== 'starting' && c.status !== 'restarting';
  let reason: string | undefined;
  if (c.status === 'restarting') reason = 'Restarting';
  else if (c.status === 'exited' || c.status === 'dead') reason = `Exited (${c.exitCode})`;
  else if (c.healthStatus === 'unhealthy') reason = 'Unhealthy';
  return {
    name: c.name,
    phase,
    ready,
    restarts: c.restartCount,
    ...(reason ? { reason } : {}),
  };
}

export function containerNameFor(stackName: string): string {
  return `appliance-${stackName}`;
}

function urlForHostPort(hostPort: number | undefined): string | undefined {
  return hostPort ? `http://localhost:${hostPort}` : undefined;
}

function parseEnvLabel(value: string | undefined): Record<string, string> | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as Record<string, string>;
    return typeof parsed === 'object' && parsed !== null ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isNoSuchContainer(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /no such (container|object)/i.test(message);
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
