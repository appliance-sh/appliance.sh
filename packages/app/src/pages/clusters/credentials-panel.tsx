import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { MicroVmInstanceHost } from '@/lib/host';

// Per-host credential capture/injection (apiKeyHelper): the proxy can
// lift a credential header off a workload's request into a host-side
// store and/or inject it onto outbound requests, so secrets live
// outside the VM. Requires TLS interception (the proxy must see
// decrypted headers).
//
// `mitmOn` is passed in by the ② cluster-detail container from the SINGLE
// lifted egress-policy query (docs/desktop-ia.md §5.5) — this panel used to
// run its own `['microvm', name, 'egress']` 15 s poll only to read
// `policy.mitm`, doubling the egress fetch. It no longer fetches the policy;
// the credentials list (a separate key) stays local.
export function CredentialsPanel({ vm, name, mitmOn }: { vm: MicroVmInstanceHost; name: string; mitmOn: boolean }) {
  const queryClient = useQueryClient();
  const creds = vm.creds;
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  // New-rule form.
  const [ruleHost, setRuleHost] = React.useState('');
  const [capture, setCapture] = React.useState(true);
  const [inject, setInject] = React.useState(true);
  const [header, setHeader] = React.useState('authorization');
  const [helper, setHelper] = React.useState('');

  const credsQuery = useQuery({
    queryKey: ['microvm', name, 'creds'],
    queryFn: () => creds.list(),
    refetchInterval: 15_000,
  });
  const data = credsQuery.data;
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['microvm', name, 'creds'] });

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

  const addRule = () => {
    const h = ruleHost.trim();
    if (!h) return;
    const helperCmd = helper.trim();
    setRuleHost('');
    setHelper('');
    void act(() =>
      creds.add({ host: h, capture, inject, header: header.trim() || 'authorization', helper: helperCmd || undefined })
    );
  };

  return (
    <details className="rounded-md border border-[var(--color-border)] p-3" open>
      <summary className="cursor-pointer text-xs font-medium">
        Credentials
        {data ? (
          <span className="ml-2 text-[10px] text-[var(--color-muted-foreground)]">
            {data.rules.length} rule{data.rules.length === 1 ? '' : 's'} · {data.secrets.length} stored
          </span>
        ) : null}
      </summary>

      <p className="mt-2 text-[10px] text-[var(--color-muted-foreground)]">
        Per host, capture a credential header into a host-side store (outside the VM) and/or inject it onto outbound
        requests — so workloads never hold the secret. Injection can source from a stored secret or an{' '}
        <code className="font-mono">apiKeyHelper</code> command. Requires TLS interception.
      </p>

      {!mitmOn ? (
        <p className="mt-2 rounded-md border border-amber-500/40 bg-amber-500/5 px-2 py-1 text-[11px] text-amber-200">
          TLS interception is off — enable it under the Egress tab for capture/injection to take effect.
        </p>
      ) : null}

      <div className="mt-3 space-y-3">
        {/* Add-rule form */}
        <div className="space-y-2 rounded-md border border-[var(--color-border)] p-2">
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={ruleHost}
              onChange={(e) => setRuleHost(e.target.value)}
              placeholder="host, e.g. api.openai.com"
              className="flex-1 rounded-md border border-[var(--color-border)] bg-transparent px-2 py-1 font-mono text-xs"
            />
            <input
              type="text"
              value={header}
              onChange={(e) => setHeader(e.target.value)}
              placeholder="header"
              className="w-28 rounded-md border border-[var(--color-border)] bg-transparent px-2 py-1 font-mono text-xs"
            />
          </div>
          <input
            type="text"
            value={helper}
            onChange={(e) => setHelper(e.target.value)}
            placeholder="apiKeyHelper command (optional) — stdout is the credential"
            className="w-full rounded-md border border-[var(--color-border)] bg-transparent px-2 py-1 font-mono text-xs"
          />
          <div className="flex flex-wrap items-center gap-3">
            <label className="inline-flex items-center gap-1.5 text-xs">
              <input type="checkbox" checked={capture} onChange={(e) => setCapture(e.target.checked)} /> Capture
            </label>
            <label className="inline-flex items-center gap-1.5 text-xs">
              <input type="checkbox" checked={inject} onChange={(e) => setInject(e.target.checked)} /> Inject
            </label>
            <Button
              variant="outline"
              size="sm"
              className="ml-auto"
              disabled={busy || !ruleHost.trim()}
              onClick={addRule}
            >
              <Plus className="h-3.5 w-3.5" /> Add rule
            </Button>
          </div>
        </div>

        {/* Rules */}
        {data && data.rules.length > 0 ? (
          <ul className="space-y-1">
            {data.rules.map((r) => (
              <li
                key={r.host}
                className="flex items-center gap-2 rounded-md border border-[var(--color-border)] px-2 py-1 text-[11px]"
              >
                <span className="min-w-0 flex-1 truncate font-mono">{r.host}</span>
                <span className="shrink-0 font-mono text-[10px] text-[var(--color-muted-foreground)]">{r.header}</span>
                {r.capture ? (
                  <span className="shrink-0 rounded bg-cyan-500/15 px-1 text-[10px] text-cyan-300">capture</span>
                ) : null}
                {r.inject ? (
                  <span className="shrink-0 rounded bg-green-500/15 px-1 text-[10px] text-green-300">inject</span>
                ) : null}
                {r.helper ? (
                  <span className="shrink-0 rounded bg-[var(--color-muted)] px-1 text-[10px]">helper</span>
                ) : null}
                <button
                  type="button"
                  aria-label={`Remove ${r.host}`}
                  disabled={busy}
                  onClick={() => void act(() => creds.remove(r.host))}
                  className="shrink-0 rounded p-0.5 text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)] disabled:opacity-50"
                >
                  <X className="h-3 w-3" />
                </button>
              </li>
            ))}
          </ul>
        ) : null}

        {/* Stored secrets */}
        {data && data.secrets.length > 0 ? (
          <div>
            <div className="mb-1 flex items-center justify-between">
              <span className="text-[10px] uppercase tracking-wide text-[var(--color-muted-foreground)]">
                Stored secrets
              </span>
              <button
                type="button"
                disabled={busy}
                onClick={() => void act(() => creds.forget())}
                className="text-[10px] text-[var(--color-muted-foreground)] hover:text-red-300"
              >
                Forget all
              </button>
            </div>
            <ul className="space-y-0.5">
              {data.secrets.map((s) => (
                <li key={`${s.host}:${s.header}`} className="flex items-center gap-2 px-1 text-[11px]">
                  <span className="min-w-0 flex-1 truncate font-mono">{s.host}</span>
                  <span className="font-mono text-[10px] text-[var(--color-muted-foreground)]">{s.header}</span>
                  <span className="font-mono text-[10px] text-cyan-300">{s.masked}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>

      {err ? <p className="mt-2 text-xs text-red-300">{err}</p> : null}
    </details>
  );
}
