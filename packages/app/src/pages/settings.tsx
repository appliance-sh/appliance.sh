import * as React from 'react';
import { Link } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { useHost } from '@/providers/host-provider';

export function SettingsPage() {
  const host = useHost();
  const queryClient = useQueryClient();
  const canBootstrap = Boolean(host.bootstrap);

  const { data: config, isLoading } = useQuery({
    queryKey: ['host', 'config'],
    queryFn: () => host.getConfig(),
  });

  const [disconnecting, setDisconnecting] = React.useState(false);
  const onDisconnect = async () => {
    setDisconnecting(true);
    try {
      if (host.disconnect) {
        await host.disconnect();
      } else {
        await host.clearApiKey();
        if (host.saveApiServerUrl) await host.saveApiServerUrl('');
      }
      await queryClient.invalidateQueries({ queryKey: ['host', 'config'] });
    } finally {
      setDisconnecting(false);
    }
  };

  return (
    <div className="max-w-2xl space-y-8">
      <div>
        <h1 className="text-xl font-semibold">Settings</h1>
        <p className="mt-1 text-sm text-[var(--color-muted-foreground)]">
          Connection details for the Appliance cluster this shell is attached to.
        </p>
      </div>

      <Section title="Cluster" description="The api-server this shell talks to and the credentials it uses.">
        {isLoading ? (
          <Row label="Status" value={<span className="text-[var(--color-muted-foreground)]">Loading…</span>} />
        ) : config?.apiServerUrl ? (
          <>
            <Row label="API server" value={<code className="font-mono text-xs">{config.apiServerUrl}</code>} />
            <Row
              label="API key"
              value={
                config.apiKey ? (
                  <code className="font-mono text-xs">{config.apiKey.id}</code>
                ) : (
                  <span className="text-[var(--color-muted-foreground)]">not set</span>
                )
              }
            />
            <div className="flex gap-2 pt-2">
              <Button asChild variant="outline">
                <Link to="/connect">Change</Link>
              </Button>
              <Button variant="destructive" onClick={onDisconnect} disabled={disconnecting}>
                {disconnecting ? 'Disconnecting…' : 'Disconnect'}
              </Button>
            </div>
          </>
        ) : (
          <>
            <Row label="Status" value={<span className="text-[var(--color-muted-foreground)]">Not connected</span>} />
            <div className="flex gap-2 pt-2">
              <Button asChild>
                <Link to="/connect">Connect</Link>
              </Button>
              {canBootstrap ? (
                <Button asChild variant="outline">
                  <Link to="/bootstrap">Bootstrap new installation</Link>
                </Button>
              ) : null}
            </div>
          </>
        )}
      </Section>

      <Section title="About">
        <Row label="Version" value={<code className="font-mono text-xs">{__APPLIANCE_VERSION__}</code>} />
        <Row
          label="Built"
          value={
            <span className="text-[var(--color-muted-foreground)]" title={__APPLIANCE_BUILD_TIME__}>
              {new Date(__APPLIANCE_BUILD_TIME__).toLocaleString()}
            </span>
          }
        />
        <Row
          label="Shell"
          value={
            <span className="text-[var(--color-muted-foreground)]">{canBootstrap ? 'Desktop (Tauri)' : 'Web'}</span>
          }
        />
      </Section>
    </div>
  );
}

function Section({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3 rounded-md border border-[var(--color-border)] p-4">
      <div>
        <h2 className="text-sm font-semibold">{title}</h2>
        {description ? <p className="mt-0.5 text-xs text-[var(--color-muted-foreground)]">{description}</p> : null}
      </div>
      <dl className="space-y-2">{children}</dl>
    </section>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[auto_1fr] items-baseline gap-4">
      <dt className="text-xs text-[var(--color-muted-foreground)]">{label}</dt>
      <dd className="text-sm">{value}</dd>
    </div>
  );
}
