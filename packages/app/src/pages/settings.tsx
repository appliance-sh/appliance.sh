import * as React from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useHost } from '@/providers/host-provider';
import { useSelectedCluster } from '@/hooks/use-selected-cluster';
import type { BootstrapEvent, Cluster, ConsoleHost } from '@/lib/host';
import { cn } from '@/lib/utils';

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
              {clusters.map((c) => (
                <ClusterRow
                  key={c.id}
                  cluster={c}
                  isSelected={c.id === selectedId}
                  onSelect={() => selectMutation.mutate(c.id)}
                  selectPending={selectMutation.isPending}
                  onRemove={() => onRemove(c)}
                  removePending={removeMutation.isPending}
                />
              ))}
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

function ClusterRow({
  cluster,
  isSelected,
  onSelect,
  selectPending,
  onRemove,
  removePending,
}: {
  cluster: Cluster;
  isSelected: boolean;
  onSelect: () => void;
  selectPending: boolean;
  onRemove: () => void;
  removePending: boolean;
}) {
  const host = useHost();
  // Show the panel whenever the host can drive a state promotion.
  // We don't gate on `cluster.stateBackendUrl` being cached because
  // clusters bootstrapped before that field was persisted (or added
  // manually via Connect) won't have it — the user types the URL in
  // when it isn't already known.
  const canPromote = Boolean(host.bootstrap?.promoteState);

  return (
    <li className="px-3 py-2">
      <div className="grid grid-cols-[auto_1fr_auto] items-center gap-3">
        <div className="w-4">{isSelected ? <Check className="h-4 w-4 text-[var(--color-accent)]" /> : null}</div>
        <div className="min-w-0">
          <div className="text-sm font-medium">{cluster.name}</div>
          <div className="truncate font-mono text-xs text-[var(--color-muted-foreground)]">{cluster.apiServerUrl}</div>
        </div>
        <div className="flex items-center gap-1">
          {!isSelected ? (
            <Button variant="outline" size="sm" onClick={onSelect} disabled={selectPending}>
              Switch
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="icon"
            onClick={onRemove}
            disabled={removePending}
            aria-label={`Remove ${cluster.name}`}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>
      {canPromote ? (
        <>
          <StateMigrationPanel cluster={cluster} direction="promote" />
          <StateMigrationPanel cluster={cluster} direction="demote" />
        </>
      ) : null}
    </li>
  );
}

type RunStatus = 'idle' | 'running' | 'succeeded' | 'failed';
type Direction = 'promote' | 'demote';

const COPY: Record<
  Direction,
  {
    title: string;
    description: React.ReactNode;
    runLabel: string;
    runningLabel: string;
    successLabel: string;
  }
> = {
  promote: {
    title: 'Detach state from this device',
    description: (
      <>
        Move this cluster&apos;s installer Pulumi state from{' '}
        <code className="font-mono">~/.appliance/pulumi-state</code> into the cluster&apos;s S3 state bucket so future
        operations don&apos;t require this machine.
      </>
    ),
    runLabel: 'Detach state',
    runningLabel: 'Detaching…',
    successLabel: '✓ State moved to S3',
  },
  demote: {
    title: 'Reattach state to this device',
    description: (
      <>
        Pull installer state from the cluster&apos;s S3 backend back to{' '}
        <code className="font-mono">~/.appliance/pulumi-state</code>. Refuses to overwrite an existing local state dir —
        archive or remove it first. The S3 stack is left in place as a backup.
      </>
    ),
    runLabel: 'Reattach state',
    runningLabel: 'Reattaching…',
    successLabel: '✓ State copied to local',
  },
};

function StateMigrationPanel({ cluster, direction }: { cluster: Cluster; direction: Direction }) {
  const host = useHost();
  const queryClient = useQueryClient();
  const [status, setStatus] = React.useState<RunStatus>('idle');
  const [logs, setLogs] = React.useState<string[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const [awsProfile, setAwsProfile] = React.useState('');
  const [stateBackendUrl, setStateBackendUrl] = React.useState(cluster.stateBackendUrl ?? '');
  const stateBackendUrlValid = stateBackendUrl.startsWith('s3://') && stateBackendUrl.length > 's3://'.length;
  const profilesQuery = useQuery({
    queryKey: ['aws-profiles'],
    enabled: Boolean(host.bootstrap?.listAwsProfiles),
    queryFn: () => host.bootstrap!.listAwsProfiles!(),
  });
  const profiles = profilesQuery.data ?? [];
  const canEnumerateProfiles = Boolean(host.bootstrap?.listAwsProfiles);

  const handleEvent = React.useCallback((e: BootstrapEvent) => {
    switch (e.type) {
      case 'log':
        setLogs((prev) => [...prev, e.message]);
        break;
      case 'phase-failed':
        setLogs((prev) => [...prev, `phase 3 failed: ${e.error}`]);
        break;
      case 'resource':
        if (e.op === 'same') return;
        setLogs((prev) => [...prev, `${e.op.padEnd(7)} ${e.resourceType}  ${e.name}`]);
        break;
      default:
        break;
    }
  }, []);

  const onRun = async () => {
    if (!stateBackendUrlValid) return;
    const action = direction === 'promote' ? host.bootstrap?.promoteState : host.bootstrap?.demoteState;
    if (!action) return;
    setStatus('running');
    setLogs([]);
    setError(null);
    try {
      await action.call(
        host.bootstrap,
        { stateBackendUrl, awsProfile: awsProfile || undefined },
        undefined,
        handleEvent
      );
      // After promote: clear the cached URL — local state is gone.
      // After demote: cache the URL so a future re-promote can default it.
      await setClusterStateBackendIfPossible(host, cluster.id, direction === 'promote' ? null : stateBackendUrl);
      await queryClient.invalidateQueries({ queryKey: ['host', 'config'] });
      setStatus('succeeded');
    } catch (err) {
      setStatus('failed');
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const copy = COPY[direction];

  return (
    <div className="ml-7 mt-2 space-y-2 rounded-md border border-[var(--color-border)] p-3">
      <div>
        <div className="text-sm font-medium">{copy.title}</div>
        <div className="text-xs text-[var(--color-muted-foreground)]">{copy.description}</div>
      </div>

      <label className="block space-y-1 text-xs">
        <span className="text-[var(--color-muted-foreground)]">State backend URL</span>
        <input
          type="text"
          value={stateBackendUrl}
          onChange={(e) => setStateBackendUrl(e.target.value)}
          placeholder="s3://us-east-1-state-XXXXXXX"
          disabled={status === 'running'}
          spellCheck={false}
          className="w-full rounded-md border border-[var(--color-border)] bg-transparent px-2 py-1.5 font-mono text-sm disabled:opacity-50"
        />
        <span className="text-[var(--color-muted-foreground)]">
          The cluster&apos;s state bucket. Find it in S3 under a name like{' '}
          <code className="font-mono">&lt;region&gt;-state-&lt;7-char hash&gt;</code>.
        </span>
      </label>

      <label className="block space-y-1 text-xs">
        <span className="text-[var(--color-muted-foreground)]">AWS profile</span>
        {canEnumerateProfiles ? (
          <select
            value={awsProfile}
            onChange={(e) => setAwsProfile(e.target.value)}
            disabled={status === 'running'}
            className="w-full rounded-md border border-[var(--color-border)] bg-transparent px-2 py-1.5 text-sm disabled:opacity-50"
          >
            <option value="">— shell environment —</option>
            {profiles.map((p) => (
              <option key={p.name} value={p.name}>
                {p.name}
                {p.isSso ? '  (SSO)' : ''}
              </option>
            ))}
          </select>
        ) : (
          <input
            type="text"
            value={awsProfile}
            onChange={(e) => setAwsProfile(e.target.value)}
            placeholder="leave empty to use shell env"
            disabled={status === 'running'}
            className="w-full rounded-md border border-[var(--color-border)] bg-transparent px-2 py-1.5 font-mono text-sm disabled:opacity-50"
          />
        )}
      </label>

      <div className="flex items-center gap-2">
        <Button size="sm" onClick={onRun} disabled={status === 'running' || !stateBackendUrlValid}>
          {status === 'running' ? copy.runningLabel : copy.runLabel}
        </Button>
        {status === 'succeeded' ? <span className="text-xs text-green-400">{copy.successLabel}</span> : null}
        {status === 'failed' ? <span className="text-xs text-red-400">Failed</span> : null}
      </div>

      {logs.length > 0 || error ? (
        <div className="rounded-md border border-[var(--color-border)] bg-black/30">
          <div className="max-h-48 overflow-auto px-2 py-1.5 font-mono text-xs leading-relaxed">
            {logs.map((l, i) => (
              <div key={i} className="whitespace-pre-wrap">
                {l}
              </div>
            ))}
            {error ? <div className={cn('whitespace-pre-wrap', 'text-red-400')}>{error}</div> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

async function setClusterStateBackendIfPossible(
  host: ConsoleHost,
  clusterId: string,
  url: string | null
): Promise<void> {
  if (!host.setClusterStateBackend) return;
  try {
    await host.setClusterStateBackend(clusterId, url);
  } catch {
    // Best-effort: caching the URL is convenience, not correctness.
    // Failure here doesn't affect the state migration that succeeded.
  }
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
