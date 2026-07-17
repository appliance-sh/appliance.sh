import chalk from 'chalk';
import type { createApplianceClient, WorkloadPod } from '@appliance.sh/sdk';

// Merged, color-prefixed log streaming for `appliance dev`: one LogMux
// tracks every stack member's environment, discovers its pods by
// polling the workloads API, and fans each Running pod's follow-stream
// into a single prefixed terminal feed. Rollouts need no special
// handling — a redeploy's new pod simply appears in the next poll.

type Client = ReturnType<typeof createApplianceClient>;

const PALETTE = [chalk.cyan, chalk.magenta, chalk.yellow, chalk.green, chalk.blue, chalk.redBright];

export function colorFor(index: number): (s: string) => string {
  return PALETTE[index % PALETTE.length];
}

/** One prefixed log line: `member    | text`, prefix colored per
 *  member. Pure — exported for tests. */
export function formatLogLine(label: string, padTo: number, colorIdx: number, line: string): string {
  return `${colorFor(colorIdx)(`${label.padEnd(padTo)} |`)} ${line}`;
}

/** Pods that should have a live stream: Running and not already
 *  streamed. Pure — exported for tests. */
export function diffPods(current: WorkloadPod[], streaming: ReadonlySet<string>): WorkloadPod[] {
  return current.filter((p) => p.phase === 'Running' && !streaming.has(p.name));
}

interface TrackedMember {
  label: string;
  environmentId: string;
  colorIdx: number;
  /** Pod name → live stream abort. */
  streams: Map<string, AbortController>;
  /** Pods that have ever streamed — a reconnect (same pod, stream
   *  dropped) tails less to avoid re-printing history. */
  everStreamed: Set<string>;
  /** Pod name → display ordinal for multi-replica members. */
  ordinals: Map<string, number>;
}

export class LogMux {
  private readonly members = new Map<string, TrackedMember>();
  private readonly pollMs: number;
  private readonly padTo: number;
  private timer: NodeJS.Timeout | null = null;
  private polling = false;
  private stopped = false;

  constructor(
    private readonly client: Client,
    opts: { padTo: number; pollMs?: number }
  ) {
    this.pollMs = opts.pollMs ?? 5_000;
    this.padTo = opts.padTo;
  }

  /** Track a member's environment; starts the poll loop on first add
   *  and polls immediately so first logs appear fast. */
  add(label: string, environmentId: string): void {
    if (this.stopped || this.members.has(label)) return;
    this.members.set(label, {
      label,
      environmentId,
      colorIdx: this.members.size,
      streams: new Map(),
      everStreamed: new Set(),
      ordinals: new Map(),
    });
    void this.poll();
    this.timer ??= setInterval(() => void this.poll(), this.pollMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const member of this.members.values()) {
      for (const ctl of member.streams.values()) ctl.abort();
      member.streams.clear();
    }
  }

  private async poll(): Promise<void> {
    if (this.polling || this.stopped) return;
    this.polling = true;
    try {
      for (const member of this.members.values()) {
        const workloads = await this.client.listEnvironmentWorkloads(member.environmentId);
        if (this.stopped) return;
        if (!workloads.success) continue; // transient — next poll retries
        for (const pod of diffPods(workloads.data.pods, new Set(member.streams.keys()))) {
          this.openStream(member, pod.name);
        }
      }
    } catch {
      // Never let a poll failure kill the loop; the next tick retries.
    } finally {
      this.polling = false;
    }
  }

  private openStream(member: TrackedMember, podName: string): void {
    const ctl = new AbortController();
    member.streams.set(podName, ctl);
    if (!member.ordinals.has(podName)) member.ordinals.set(podName, member.ordinals.size);
    const ordinal = member.ordinals.get(podName) ?? 0;
    const label = ordinal === 0 ? member.label : `${member.label}/${ordinal + 1}`;
    // First stream of a pod tails recent history; a reconnect only
    // catches up the poll gap instead of re-printing the tail.
    const opts = member.everStreamed.has(podName)
      ? { sinceSeconds: Math.ceil(this.pollMs / 1000) + 1, signal: ctl.signal }
      : { tailLines: 20, signal: ctl.signal };
    member.everStreamed.add(podName);
    void this.client
      .streamPodLogs(podName, opts, (line) => {
        if (!this.stopped) process.stdout.write(`${formatLogLine(label, this.padTo, member.colorIdx, line)}\n`);
      })
      .finally(() => {
        // Stream ended (pod gone, rollout, or transient drop) — forget
        // it so the next poll re-opens if the pod still exists.
        member.streams.delete(podName);
      });
  }
}
