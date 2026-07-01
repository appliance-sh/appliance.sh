import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { cn } from '@/lib/utils';
import { NETSTACK_BAKED_ALLOWLIST } from '@/lib/host';
import { relativeAge } from '@/lib/time';
import type { EgressEvent, EgressPolicy, MicroVmInstanceHost } from '@/lib/host';

// Guest egress firewall surface (egress-firewall F4): show whether the
// VM's egress is the host-enforced boundary (net_link=Netstack →
// default-DENY + allowlist) or the cooperative NAT proxy, the effective
// policy (baked + operator rules), the denied attempts, and a one-click
// allow for a blocked host. The engine enforces it (packages/vm
// egress.rs / netstack); this is read + incremental edits only — it never
// writes the whole effective policy back (see the host bridge's addRule).
//
// The egress POLICY query is LIFTED to the ② cluster-detail container
// (docs/desktop-ia.md §5.5): EgressPanel and CredentialsPanel used to each
// register their own 15 s `['microvm', name, 'egress']` poll. The container
// now owns the single poll and passes `policy` down here (and `mitm` to the
// credentials panel) — one observer, one source of truth. Edits still go
// through `queryClient.invalidateQueries(['microvm', name, 'egress'])`, which
// the lifted query observes. The live traffic feed (a separate key) stays
// local to this panel.
export function EgressPanel({
  vm,
  name,
  policy,
  policyError,
}: {
  vm: MicroVmInstanceHost;
  name: string;
  policy: EgressPolicy | undefined;
  policyError: unknown;
}) {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const egress = vm.egress;
  const [host_, setHost] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['microvm', name, 'egress'] });

  // Live traffic feed — the boundary records every request decision
  // (allow/deny/mitm). The denied-attempts view rolls up the deny records.
  const trafficQuery = useQuery({
    queryKey: ['microvm', name, 'egress', 'log'],
    queryFn: () => egress.log(200),
    refetchInterval: 4_000,
  });
  const events = trafficQuery.data ?? [];

  const enforced = !!policy?.enforced;
  // For a Netstack VM the effective `allow` merges the baked allowlist with
  // the operator's rules; partition it back so the UI shows what's inherited
  // (always-on) vs what the operator added — mirrors render_effective_policy.
  const operatorAllow = React.useMemo(() => {
    if (!policy) return [] as string[];
    return policy.enforced ? policy.allow.filter((h) => !isBaked(h)) : policy.allow;
  }, [policy]);

  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      refresh();
    }
  };

  const addRule = (action: 'allow' | 'deny') => {
    const h = host_.trim();
    if (!h) return;
    setHost('');
    void act(() => egress.addRule(action, h));
  };

  // Allow a host. On the ENFORCED (Netstack) boundary a one-click allow
  // silently WIDENS the boundary, and the engine's `egress allow` also
  // drops an EXACT-match operator deny (deny.retain) — so confirm first
  // and name the deny removal when one will actually be deleted. The
  // cooperative/NAT proxy is already bypassable, so it stays one-click.
  const allowHost = async (host: string) => {
    if (policy && enforced) {
      const removesDeny = policy.deny.includes(host);
      const ok = await confirm({
        title: `Allow egress to ${host}?`,
        description:
          `This widens the enforced boundary` + (removesDeny ? `, and removes your deny rule for ${host}` : '') + '.',
        confirmLabel: 'Allow',
        // Widening egress is a deliberate-but-not-destructive action — render
        // the primary (non-red) confirm style rather than the delete style.
        destructive: false,
      });
      if (!ok) return;
    }
    void act(() => egress.addRule('allow', host));
  };

  // Per-rule remove (the "×" on a rule): incremental drop of one host from
  // the persisted policy — never a whole effective-policy write-back.
  // "Reset rules" stays the clear-everything path.
  const removeHost = (host: string) => void act(() => egress.removeRule(host));

  // Distinct denied destinations — surfaced as a badge on the collapsed
  // summary so a hung install (everything blocked) self-advertises.
  const deniedCount = React.useMemo(() => aggregateDenied(events).length, [events]);

  return (
    <details className="rounded-md border border-[var(--color-border)] p-3" open>
      <summary className="cursor-pointer text-xs font-medium">
        Egress firewall
        {policy ? (
          <span className="ml-2 text-[10px] text-[var(--color-muted-foreground)]">
            {enforced ? 'enforced · default DENY' : `cooperative · default ${policy.default}`}
            {policy.mitm ? ' · TLS interception on' : ''}
          </span>
        ) : null}
        {deniedCount > 0 ? (
          <span className="ml-1.5 text-[10px] font-medium text-red-300">· {deniedCount} denied</span>
        ) : null}
      </summary>

      {policy ? (
        <div className="mt-3 space-y-3">
          {/* Firewall status: is the host netstack the enforced boundary
              (net_link=Netstack), or the cooperative NAT proxy? */}
          <div
            className={cn(
              'rounded-md border px-2.5 py-2 text-[11px]',
              enforced ? 'border-emerald-500/30 bg-emerald-500/5' : 'border-amber-500/30 bg-amber-500/5'
            )}
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className={cn('font-medium', enforced ? 'text-emerald-200' : 'text-amber-200')}>
                {enforced ? 'Enforced boundary' : 'Cooperative proxy'}
              </span>
              <span className="font-mono text-[10px] text-[var(--color-muted-foreground)]">
                net_link={policy.netLink ?? (enforced ? 'netstack' : 'nat')}
              </span>
            </div>
            <p className="mt-1 text-[10px] leading-relaxed text-[var(--color-muted-foreground)]">
              {enforced ? (
                <>
                  The host netstack is the only path off-box: egress is{' '}
                  <span className="text-emerald-200">default-DENY</span> plus an allowlist, enforced even for a rooted
                  guest that drops the proxy env or dials a raw IP. The rules below are the effective policy. Deny wins
                  over allow.
                  <br />
                  <span className="text-amber-200">It controls where traffic goes, not what leaves</span> — trim the
                  allowlist (e.g. drop <code className="font-mono">github.com</code>) for untrusted code.
                </>
              ) : (
                <>
                  Egress is unconfined at the link — this policy is a{' '}
                  <span className="text-amber-200">cooperative</span> proxy a workload can bypass (raw IP, dropped{' '}
                  <code className="font-mono">HTTPS_PROXY</code>). Recreate the VM on{' '}
                  <code className="font-mono">net_link=Netstack</code> to make it the enforced boundary. Deny wins over
                  allow.
                </>
              )}
            </p>
          </div>

          {/* Controls. A Netstack VM's default is host-enforced DENY, so we
              show it read-only (toggling it would persist into the file and
              mis-enforce under NAT); a NAT VM keeps the allow/deny toggle. */}
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs">Default:</span>
            {enforced ? (
              <span className="rounded-md border border-red-500/30 bg-red-500/10 px-2 py-1 text-xs text-red-200">
                deny <span className="text-[10px] text-[var(--color-muted-foreground)]">host-enforced</span>
              </span>
            ) : (
              <div className="inline-flex overflow-hidden rounded-md border border-[var(--color-border)]">
                {(['allow', 'deny'] as const).map((a) => (
                  <button
                    key={a}
                    type="button"
                    disabled={busy}
                    onClick={() => policy.default !== a && void act(() => egress.setDefault(a))}
                    className={cn(
                      'px-2 py-1 text-xs',
                      policy.default === a
                        ? a === 'deny'
                          ? 'bg-red-500/20 text-red-200'
                          : 'bg-green-500/20 text-green-200'
                        : 'text-[var(--color-muted-foreground)] hover:bg-[var(--color-muted)]'
                    )}
                  >
                    {a}
                  </button>
                ))}
              </div>
            )}
            <label className="ml-2 inline-flex items-center gap-1.5 text-xs">
              <input
                type="checkbox"
                checked={policy.mitm}
                disabled={busy}
                onChange={(e) => void act(() => egress.setMitm(e.target.checked))}
              />
              TLS interception
            </label>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => void act(() => egress.reset())}>
              Reset rules
            </Button>
          </div>

          {policy.mitm && policy.caPath ? (
            <p className="rounded-md border border-cyan-500/30 bg-cyan-500/5 px-2 py-1 font-mono text-[10px] text-cyan-200">
              CA: {policy.caPath} — inject into workloads to trust the interceptor
            </p>
          ) : null}

          {/* Add a rule. Both Allow and Deny go through the incremental
              addRule bridge → `egress allow|deny <host>` (load→add→save on
              the PERSISTED policy); never a whole effective-policy write-back. */}
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={host_}
              onChange={(e) => setHost(e.target.value)}
              placeholder="host suffix, e.g. github.com"
              className="flex-1 rounded-md border border-[var(--color-border)] bg-transparent px-2 py-1 font-mono text-xs"
              onKeyDown={(e) => {
                if (e.key === 'Enter') addRule('allow');
              }}
            />
            <Button variant="outline" size="sm" disabled={busy || !host_.trim()} onClick={() => addRule('allow')}>
              Allow
            </Button>
            <Button variant="outline" size="sm" disabled={busy || !host_.trim()} onClick={() => addRule('deny')}>
              Deny
            </Button>
          </div>

          {/* Effective policy. For a Netstack VM the baked allowlist is
              always-on; operator rules are shown apart so it's clear what's
              inherited vs what you added. */}
          {enforced ? <BakedAllowlist deny={policy.deny} /> : null}
          <RuleList
            label={enforced ? 'Operator allow' : 'Allowed'}
            hosts={operatorAllow}
            tone="green"
            busy={busy}
            onRemove={removeHost}
          />
          <RuleList
            label={enforced ? 'Operator deny (wins over allow)' : 'Denied'}
            hosts={policy.deny}
            tone="red"
            busy={busy}
            onRemove={removeHost}
          />

          {trafficQuery.isError ? (
            <p className="text-[11px] text-red-300">Failed to load traffic: {errMessage(trafficQuery.error)}</p>
          ) : null}

          <DeniedAttempts events={events} policy={policy} busy={busy} onAllow={allowHost} />

          <TrafficView
            events={events}
            policy={policy}
            busy={busy}
            onAllow={allowHost}
            onBlock={(h) => void act(() => egress.addRule('deny', h))}
            onClear={() =>
              void egress
                .clearLog()
                .then(() => queryClient.invalidateQueries({ queryKey: ['microvm', name, 'egress', 'log'] }))
            }
          />
        </div>
      ) : policyError ? (
        // Don't spin on "Loading policy…" forever when egress.get() rejects.
        <p className="mt-2 text-xs text-red-300">Failed to load egress policy: {errMessage(policyError)}</p>
      ) : (
        <p className="mt-2 text-xs text-[var(--color-muted-foreground)]">Loading policy…</p>
      )}

      {err ? <p className="mt-2 text-xs text-red-300">{err}</p> : null}
    </details>
  );
}

/** Is `host` one of the baked, always-on Netstack allowlist entries? Used
 *  to partition the effective `allow` into baked vs operator rules. */
function isBaked(host: string): boolean {
  const h = host.trim().replace(/\.$/, '').toLowerCase();
  return NETSTACK_BAKED_ALLOWLIST.some((b) => b.toLowerCase() === h);
}

/** The baked allowlist for a Netstack VM — always-on (§5 of the design),
 *  shown read-only. A baked host an operator deny rule overrides is struck
 *  through, mirroring the engine's effective-policy report. */
function BakedAllowlist({ deny }: { deny: string[] }) {
  const overridden = (h: string) => deny.some((d) => hostMatches(h, d));
  return (
    <div>
      <div className="mb-1 text-[10px] uppercase tracking-wide text-[var(--color-muted-foreground)]">
        Baked allowlist <span className="normal-case opacity-70">(always-on for Netstack VMs)</span>
      </div>
      <ul className="flex flex-wrap gap-1.5">
        {NETSTACK_BAKED_ALLOWLIST.map((h) => {
          const off = overridden(h);
          return (
            <li
              key={h}
              title={off ? 'overridden by an operator deny rule' : undefined}
              className={cn(
                'rounded-md border px-1.5 py-0.5 font-mono text-[11px]',
                off ? 'border-red-500/30 text-red-300 line-through' : 'border-emerald-500/30 text-emerald-200'
              )}
            >
              {h}
              {/* The strikethrough is visual-only; spell the state out for
                  screen readers (CSS line-through isn't announced). */}
              {off ? <span className="sr-only"> (overridden by an operator deny rule)</span> : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** One destination's denied-egress roll-up — mirrors DeniedHost in
 *  packages/vm/src/traffic.rs. */
interface DeniedHost {
  host: string;
  port: number;
  count: number;
  lastSeen: number;
}

/** Aggregate the `deny` records in the traffic feed into per-(host, port)
 *  summaries, most-recently-seen first. Mirror of traffic.rs::aggregate_denied
 *  so the desktop roll-up matches the CLI's `egress denied` view. */
function aggregateDenied(events: EgressEvent[]): DeniedHost[] {
  const byDest = new Map<string, DeniedHost>();
  for (const e of events) {
    if (e.decision !== 'deny') continue;
    // Explicit `|` separator (a hostname has neither a space nor a pipe)
    // — never a raw NUL byte, which reads as file corruption to tooling.
    const key = `${e.host}|${e.port}`;
    const cur = byDest.get(key);
    if (cur) {
      cur.count += 1;
      cur.lastSeen = Math.max(cur.lastSeen, e.ts);
    } else {
      byDest.set(key, { host: e.host, port: e.port, count: 1, lastSeen: e.ts });
    }
  }
  return [...byDest.values()].sort((a, b) => b.lastSeen - a.lastSeen || a.host.localeCompare(b.host));
}

// Denied-attempts view (egress-firewall F4): the blocked→allow loop in the
// GUI. Rolls up the boundary's deny records into host:port / count / last-
// seen, most-recent-first, each with a one-click Allow that adds an
// incremental allow rule (never a whole-policy write-back).
function DeniedAttempts({
  events,
  policy,
  busy,
  onAllow,
}: {
  events: EgressEvent[];
  policy: EgressPolicy;
  busy: boolean;
  onAllow: (host: string) => void;
}) {
  const denied = aggregateDenied(events);
  return (
    <div className="space-y-1.5">
      <div className="text-[10px] uppercase tracking-wide text-[var(--color-muted-foreground)]">Denied attempts</div>
      {denied.length === 0 ? (
        <p className="rounded-md border border-dashed border-[var(--color-border)] px-2 py-1.5 text-[11px] text-[var(--color-muted-foreground)]">
          Nothing blocked yet. Traffic the boundary denies will show up here — allow a host in one click.
        </p>
      ) : (
        <ul className="max-h-44 space-y-0.5 overflow-auto rounded-md border border-[var(--color-border)] p-1">
          {denied.map((d) => {
            // Deny-first (ruledStatus): a broader suffix deny keeps a host
            // denied even when an allow rule matches, so only a TRUE
            // 'allowed' shows the green badge — otherwise keep the Allow
            // affordance (a still-denied row must not read as allowed).
            const status = ruledStatus(policy, d.host);
            return (
              <li key={`${d.host}:${d.port}`} className="flex items-center gap-2 px-1 py-0.5 text-[11px]">
                <span className="w-8 shrink-0 text-right font-mono text-[10px] text-[var(--color-muted-foreground)]">
                  {relativeAge(new Date(d.lastSeen).toISOString())}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-red-200">
                  {d.host}
                  <span className="text-[var(--color-muted-foreground)]">:{d.port}</span>
                </span>
                <span className="shrink-0 font-mono text-[10px] text-[var(--color-muted-foreground)]">×{d.count}</span>
                {status === 'allowed' ? (
                  <span className="shrink-0 text-[10px] text-green-300">allowed</span>
                ) : (
                  <>
                    {status === 'denied' ? (
                      <span
                        className="shrink-0 text-[10px] text-red-300"
                        title="A deny rule still blocks this host — remove it below to allow"
                      >
                        deny rule
                      </span>
                    ) : null}
                    <button
                      type="button"
                      disabled={busy}
                      aria-label={`Allow egress to ${d.host}:${d.port}`}
                      onClick={() => onAllow(d.host)}
                      className="shrink-0 rounded border border-green-500/40 px-1.5 text-[10px] text-green-200 hover:bg-green-500/10 disabled:opacity-50"
                    >
                      Allow
                    </button>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// Docker-Desktop-style live traffic feed: most-recent requests the
// proxy saw, each allow/deny/mitm-tagged, with one-click allow or block
// per host that updates the policy live.
function TrafficView({
  events,
  policy,
  busy,
  onAllow,
  onBlock,
  onClear,
}: {
  events: EgressEvent[];
  policy: EgressPolicy;
  busy: boolean;
  onAllow: (host: string) => void;
  onBlock: (host: string) => void;
  onClear: () => void;
}) {
  // Newest first, capped so the panel stays compact.
  const rows = [...events].reverse().slice(0, 40);
  const tone = (d: EgressEvent['decision']) =>
    d === 'deny' ? 'text-red-300' : d === 'mitm' ? 'text-cyan-300' : 'text-green-300';
  const ruled = (host: string) => ruledStatus(policy, host);

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <div className="text-[10px] uppercase tracking-wide text-[var(--color-muted-foreground)]">Live traffic</div>
        {events.length > 0 ? (
          <button
            type="button"
            onClick={onClear}
            className="text-[10px] text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)]"
          >
            Clear
          </button>
        ) : null}
      </div>
      {rows.length === 0 ? (
        <p className="rounded-md border border-dashed border-[var(--color-border)] px-2 py-1.5 text-[11px] text-[var(--color-muted-foreground)]">
          No traffic yet. Requests appear here as workloads make them.
        </p>
      ) : (
        <ul className="max-h-56 space-y-0.5 overflow-auto rounded-md border border-[var(--color-border)] p-1">
          {rows.map((e, i) => {
            const status = ruled(e.host);
            return (
              <li key={`${e.ts}-${i}`} className="flex items-center gap-2 px-1 py-0.5 text-[11px]">
                <span className="w-8 shrink-0 text-right font-mono text-[10px] text-[var(--color-muted-foreground)]">
                  {relativeAge(new Date(e.ts).toISOString())}
                </span>
                <span className={cn('w-9 shrink-0 font-mono uppercase', tone(e.decision))}>{e.decision}</span>
                <span className="min-w-0 flex-1 truncate font-mono">
                  <span className="text-[var(--color-muted-foreground)]">{e.method} </span>
                  {e.host}
                  {e.path ? <span className="text-[var(--color-muted-foreground)]">{e.path}</span> : null}
                </span>
                {status === 'allowed' ? (
                  <button
                    type="button"
                    disabled={busy}
                    aria-label={`Block egress to ${e.host}:${e.port}`}
                    onClick={() => onBlock(e.host)}
                    className="shrink-0 rounded border border-red-500/40 px-1.5 text-[10px] text-red-200 hover:bg-red-500/10 disabled:opacity-50"
                  >
                    Block
                  </button>
                ) : status === 'denied' ? (
                  <button
                    type="button"
                    disabled={busy}
                    aria-label={`Allow egress to ${e.host}:${e.port}`}
                    onClick={() => onAllow(e.host)}
                    className="shrink-0 rounded border border-green-500/40 px-1.5 text-[10px] text-green-200 hover:bg-green-500/10 disabled:opacity-50"
                  >
                    Allow
                  </button>
                ) : (
                  <span className="flex shrink-0 gap-1">
                    <button
                      type="button"
                      disabled={busy}
                      aria-label={`Allow egress to ${e.host}:${e.port}`}
                      onClick={() => onAllow(e.host)}
                      className="rounded border border-green-500/40 px-1.5 text-[10px] text-green-200 hover:bg-green-500/10 disabled:opacity-50"
                    >
                      Allow
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      aria-label={`Block egress to ${e.host}:${e.port}`}
                      onClick={() => onBlock(e.host)}
                      className="rounded border border-red-500/40 px-1.5 text-[10px] text-red-200 hover:bg-red-500/10 disabled:opacity-50"
                    >
                      Block
                    </button>
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** Mirror of the Rust host-suffix match (egress.rs): exact host or a
 *  dot-suffix. Used to show whether a row's host is already ruled. */
function hostMatches(host: string, suffix: string): boolean {
  const h = host.trim().replace(/\.$/, '').toLowerCase();
  const s = suffix.trim().replace(/^\./, '').replace(/\.$/, '').toLowerCase();
  return s !== '' && (h === s || h.endsWith('.' + s));
}

/** Deny-first effective status of a host against the policy — deny WINS
 *  over allow, mirroring the engine's `EgressPolicy::allows`. A broader
 *  suffix deny keeps a host denied even when an allow rule also matches
 *  (the engine's `egress allow` only drops an EXACT-match deny), so the
 *  denied-attempts row must use this rather than `allow.some(...)` alone
 *  or it would show a still-blocked host as green "allowed". */
function ruledStatus(policy: EgressPolicy, host: string): 'denied' | 'allowed' | null {
  if (policy.deny.some((s) => hostMatches(host, s))) return 'denied';
  if (policy.allow.some((s) => hostMatches(host, s))) return 'allowed';
  return null;
}

/** Best-effort message from an unknown thrown/rejected value. */
function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Compact allow/deny chip list with a per-rule remove (×) — the
 *  incremental counterpart of "Reset rules" (which clears every rule). */
function RuleList({
  label,
  hosts,
  tone,
  busy,
  onRemove,
}: {
  label: string;
  hosts: string[];
  tone: 'green' | 'red';
  busy?: boolean;
  onRemove?: (host: string) => void;
}) {
  if (hosts.length === 0) return null;
  return (
    <div>
      <div className="mb-1 text-[10px] uppercase tracking-wide text-[var(--color-muted-foreground)]">{label}</div>
      <ul className="flex flex-wrap gap-1.5">
        {hosts.map((h) => (
          <li
            key={h}
            className={cn(
              'inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 font-mono text-[11px]',
              tone === 'green' ? 'border-green-500/30 text-green-200' : 'border-red-500/30 text-red-200'
            )}
          >
            {h}
            {onRemove ? (
              <button
                type="button"
                disabled={busy}
                aria-label={`Remove ${tone === 'green' ? 'allow' : 'deny'} rule ${h}`}
                title="Remove this rule"
                onClick={() => onRemove(h)}
                className="rounded text-[10px] leading-none text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)] disabled:opacity-50"
              >
                ×
              </button>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
