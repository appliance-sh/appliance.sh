import * as React from 'react';
import { Link } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useHost } from '@/providers/host-provider';
import { useSelectedCluster } from '@/hooks/use-selected-cluster';
import type { Cluster } from '@/lib/host';

export function SettingsPage() {
  const host = useHost();
  const queryClient = useQueryClient();
  const canBootstrap = Boolean(host.bootstrap);
  const { config, isLoading } = useSelectedCluster();
  const clusters = config?.clusters ?? [];
  const selectedId = config?.selectedClusterId ?? null;

  const selectMutation = useMutation({
    mutationFn: async (id: string | null) => host.selectCluster(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['host', 'config'] }),
  });

  const removeMutation = useMutation({
    mutationFn: async (id: string) => host.removeCluster(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['host', 'config'] }),
  });

  const onRemove = (cluster: Cluster) => {
    const ok =
      typeof window !== 'undefined'
        ? window.confirm(
            `Remove cluster "${cluster.name}"? This forgets the URL and API key on this machine but does not destroy any infrastructure.`
          )
        : true;
    if (!ok) return;
    removeMutation.mutate(cluster.id);
  };

  return (
    <div className="max-w-2xl space-y-8">
      <div>
        <h1 className="text-xl font-semibold">Settings</h1>
        <p className="mt-1 text-sm text-[var(--color-muted-foreground)]">
          Clusters this shell is connected to, and shell info.
        </p>
      </div>

      <Section
        title="Clusters"
        description="Each cluster is one (api-server URL, API key) pair stored on this machine."
      >
        {isLoading ? (
          <Row label="Status" value={<span className="text-[var(--color-muted-foreground)]">Loading…</span>} />
        ) : clusters.length === 0 ? (
          <>
            <Row label="Status" value={<span className="text-[var(--color-muted-foreground)]">No clusters</span>} />
            <div className="flex gap-2 pt-2">
              <Button asChild>
                <Link to="/connect">
                  <Plus className="h-4 w-4" /> Add cluster
                </Link>
              </Button>
              {canBootstrap ? (
                <Button asChild variant="outline">
                  <Link to="/bootstrap">Bootstrap new installation</Link>
                </Button>
              ) : null}
            </div>
          </>
        ) : (
          <>
            <ul className="divide-y divide-[var(--color-border)] rounded-md border border-[var(--color-border)]">
              {clusters.map((c) => {
                const isSelected = c.id === selectedId;
                return (
                  <li key={c.id} className="grid grid-cols-[auto_1fr_auto] items-center gap-3 px-3 py-2">
                    <div className="w-4">
                      {isSelected ? <Check className="h-4 w-4 text-[var(--color-accent)]" /> : null}
                    </div>
                    <div className="min-w-0">
                      <div className="text-sm font-medium">{c.name}</div>
                      <div className="truncate font-mono text-xs text-[var(--color-muted-foreground)]">
                        {c.apiServerUrl}
                      </div>
                    </div>
                    <div className="flex items-center gap-1">
                      {!isSelected ? (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => selectMutation.mutate(c.id)}
                          disabled={selectMutation.isPending}
                        >
                          Switch
                        </Button>
                      ) : null}
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => onRemove(c)}
                        disabled={removeMutation.isPending}
                        aria-label={`Remove ${c.name}`}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
            <div className="flex gap-2 pt-3">
              <Button asChild variant="outline">
                <Link to="/connect">
                  <Plus className="h-4 w-4" /> Add cluster
                </Link>
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
