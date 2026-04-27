import * as React from 'react';
import { Link, useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { useHost } from '@/providers/host-provider';

// Adds a cluster: probes the URL, then calls host.addCluster() which
// persists the entry, stores the key in the OS keychain (Tauri) or
// sessionStorage (web), and selects it. On shells that can drive a
// local bootstrap (Tauri desktop) we link to the wizard instead.
export function ConnectPage() {
  const host = useHost();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const canBootstrap = Boolean(host.bootstrap);

  const [name, setName] = React.useState('');
  const [url, setUrl] = React.useState('');
  const [keyId, setKeyId] = React.useState('');
  const [secret, setSecret] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // Auto-name the cluster from the URL hostname unless the user has
  // typed something. Stops once they edit the name field.
  const userTouchedName = React.useRef(false);
  React.useEffect(() => {
    if (userTouchedName.current) return;
    const derived = deriveNameFromUrl(url);
    if (derived) setName(derived);
  }, [url]);

  const canSubmit =
    name.length > 0 && url.length > 0 && keyId.startsWith('ak') && secret.startsWith('sk_') && !submitting;

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const normalizedUrl = url.replace(/\/+$/, '');
      await verifyApiServer(normalizedUrl);
      await host.addCluster({
        name,
        apiServerUrl: normalizedUrl,
        apiKey: { id: keyId, secret },
      });
      await queryClient.invalidateQueries({ queryKey: ['host', 'config'] });
      navigate('/');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  };

  // Probe the unauthenticated bootstrap/status endpoint to confirm
  // we're actually talking to an Appliance api-server before
  // stashing credentials. 10s timeout catches silent hangs (slow
  // DNS, unreachable host) so the user doesn't get stuck on the
  // "Connecting…" button.
  async function verifyApiServer(serverUrl: string): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    let response: Response;
    try {
      response = await fetch(`${serverUrl}/bootstrap/status`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') {
        throw new Error(`${serverUrl} did not respond within 10s`);
      }
      throw new Error(`could not reach ${serverUrl} — check the URL and your network`);
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) {
      throw new Error(`${serverUrl}/bootstrap/status returned ${response.status} ${response.statusText}`);
    }
    const body = (await response.json().catch(() => null)) as { initialized?: unknown } | null;
    if (!body || typeof body.initialized !== 'boolean') {
      throw new Error(`unexpected response from ${serverUrl}/bootstrap/status — is this an Appliance api-server?`);
    }
  }

  return (
    <div className="mx-auto max-w-md space-y-6 pt-16">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold">Connect to a cluster</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Enter the URL of an Appliance api-server and an API key to add it to this shell.
          {canBootstrap ? null : (
            <>
              {' '}
              Don&apos;t have a cluster yet? Run{' '}
              <code className="rounded bg-[var(--color-muted)] px-1.5 py-0.5">appliance bootstrap</code> from the CLI.
            </>
          )}
        </p>
      </div>

      <form onSubmit={onSubmit} className="space-y-4">
        <Field label="API server URL" hint="e.g. https://api.example.appliance.sh">
          <input
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://api.example.appliance.sh"
            required
            className={inputCls}
          />
        </Field>

        <Field label="Cluster name" hint="how this cluster appears in the sidebar">
          <input
            type="text"
            value={name}
            onChange={(e) => {
              userTouchedName.current = true;
              setName(e.target.value);
            }}
            placeholder="production"
            required
            className={inputCls}
          />
        </Field>

        <Field label="Access key ID" hint="ak_…">
          <input
            type="text"
            value={keyId}
            onChange={(e) => setKeyId(e.target.value)}
            placeholder="ak_…"
            required
            className={`${inputCls} font-mono`}
          />
        </Field>

        <Field label="Secret access key" hint="sk_…">
          <input
            type="password"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            placeholder="sk_…"
            required
            className={`${inputCls} font-mono`}
          />
        </Field>

        {error ? (
          <div className="rounded-md border border-red-500/50 bg-red-500/5 p-3 text-xs text-red-400">{error}</div>
        ) : null}

        <Button type="submit" disabled={!canSubmit} className="w-full">
          {submitting ? 'Connecting…' : 'Add cluster'}
        </Button>
      </form>

      {canBootstrap ? (
        <div className="rounded-md border border-[var(--color-border)] p-4">
          <div className="text-sm">No cluster yet?</div>
          <p className="mt-1 text-xs text-[var(--color-muted-foreground)]">
            Provision one from this machine — uses your current AWS credentials.
          </p>
          <Button asChild variant="outline" className="mt-3">
            <Link to="/bootstrap">Bootstrap new installation</Link>
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function deriveNameFromUrl(url: string): string {
  try {
    const u = new URL(url);
    // Strip an "api." prefix so https://api.foo.example → "foo.example".
    return u.hostname.replace(/^api\./, '');
  } catch {
    return '';
  }
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1 text-sm">
      <div className="flex items-baseline justify-between">
        <span className="text-[var(--color-muted-foreground)]">{label}</span>
        {hint ? <span className="text-xs text-[var(--color-muted-foreground)]">{hint}</span> : null}
      </div>
      {children}
    </label>
  );
}

const inputCls =
  'w-full rounded-md border border-[var(--color-border)] bg-transparent px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]';
