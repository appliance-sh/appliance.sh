import * as React from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, Check, RefreshCw, Download, ArrowUpCircle } from 'lucide-react';
import { applianceBaseConfig, type ApplianceBaseConfig } from '@appliance.sh/sdk';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { useToast } from '@/components/ui/toast';
import { useHost } from '@/providers/host-provider';
import { useSelectedCluster } from '@/hooks/use-selected-cluster';
import { useApplianceClient } from '@/hooks/use-appliance-client';
import type { AvailableUpdate, BootstrapEvent, Cluster, ConsoleHost, UpdateProgress } from '@/lib/host';
import { cn } from '@/lib/utils';

export function SettingsPage() {
  const host = useHost();
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const { toast } = useToast();
  const canBootstrap = Boolean(host.bootstrap);
  const canSelfUpdate = Boolean(host.updater);
  const { config, isLoading } = useSelectedCluster();
  const clusters = config?.clusters ?? [];
  const selectedId = config?.selectedClusterId ?? null;

  const selectMutation = useMutation({
    mutationFn: async (id: string | null) => host.selectCluster(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['host', 'config'] }),
  });

  const removeMutation = useMutation({
    mutationFn: async (cluster: Cluster) => {
      await host.removeCluster(cluster.id);
      return cluster;
    },
    onSuccess: (cluster) => {
      queryClient.invalidateQueries({ queryKey: ['host', 'config'] });
      toast(`Cluster "${cluster.name}" removed`);
    },
  });

  const onRemove = async (cluster: Cluster) => {
    const ok = await confirm({
      title: `Remove cluster "${cluster.name}"?`,
      description: 'This forgets the URL and API key on this machine but does not destroy any infrastructure.',
      confirmLabel: 'Remove',
    });
    if (!ok) return;
    removeMutation.mutate(cluster);
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

      {canSelfUpdate ? <UpdatesSection /> : null}

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
  const canPromote = Boolean(host.bootstrap?.promoteState);
  const canTeardown = Boolean(host.bootstrap?.teardown);

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
      {/* Promote / demote / update panels read cluster metadata from
          the api-server's `/cluster-info` endpoint — that requires
          an authenticated SDK client, which we only have for the
          currently selected cluster. Other clusters get a hint
          telling the user to switch first. */}
      {canPromote && isSelected ? (
        <>
          <UpdateBaselinePanel cluster={cluster} />
          <UpdateApiServerPanel cluster={cluster} />
          <StateMigrationPanel cluster={cluster} direction="promote" />
          <StateMigrationPanel cluster={cluster} direction="demote" />
          {/* Teardown reads installer state from this device's
              ~/.appliance cache, so it's only meaningful for clusters
              bootstrapped here (lastBootstrapInput is the signal). A
              Connect-added cluster has no local state to destroy. */}
          {canTeardown && cluster.lastBootstrapInput ? <DestroyClusterPanel cluster={cluster} /> : null}
        </>
      ) : canPromote ? (
        <div className="ml-7 mt-2 rounded-md border border-dashed border-[var(--color-border)] p-3 text-xs text-[var(--color-muted-foreground)]">
          Switch to this cluster to manage its installer state and run updates.
        </div>
      ) : null}
    </li>
  );
}

function UpdateBaselinePanel({ cluster }: { cluster: Cluster }) {
  const host = useHost();
  const client = useApplianceClient();
  const { config } = useSelectedCluster();
  const apiKey = config?.apiKey ?? null;
  const [status, setStatus] = React.useState<RunStatus>('idle');
  const [logs, setLogs] = React.useState<string[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const [awsProfile, setAwsProfile] = React.useState('');

  const clusterInfoQuery = useQuery({
    queryKey: ['cluster-info', cluster.id],
    enabled: Boolean(client),
    queryFn: async () => {
      const r = await client!.getClusterInfo();
      if (!r.success) throw r.error;
      return r.data;
    },
    retry: false,
  });
  const stateBackendUrl = clusterInfoQuery.data?.baseConfig.stateBackendUrl ?? cluster.stateBackendUrl ?? '';
  const runningBaselineVersion = clusterInfoQuery.data?.baseConfig.baselineVersion ?? null;
  // The desktop ships infra at __APPLIANCE_VERSION__ — every package
  // in the monorepo moves in lockstep, so the bundled SDK / infra /
  // bootstrap versions all match the shell's reported version.
  const bundledVersion = __APPLIANCE_VERSION__;

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
        setLogs((prev) => [...prev, `phase failed: ${e.error}`]);
        break;
      case 'resource':
        if (e.op === 'same') return;
        setLogs((prev) => [...prev, `${e.op.padEnd(7)} ${e.resourceType}  ${e.name}`]);
        break;
      default:
        break;
    }
  }, []);

  const canUpdate = Boolean(host.bootstrap?.updateBaseline && cluster.lastBootstrapInput);

  const onRun = async () => {
    if (!host.bootstrap?.updateBaseline) return;
    if (!cluster.lastBootstrapInput) return;
    setStatus('running');
    setLogs([]);
    setError(null);
    try {
      await host.bootstrap.updateBaseline(
        {
          bootstrap: cluster.lastBootstrapInput,
          stateBackendUrl: stateBackendUrl || undefined,
          awsProfile: awsProfile || undefined,
          cluster: apiKey ? { apiServerUrl: cluster.apiServerUrl, apiKey } : undefined,
        },
        undefined,
        handleEvent
      );
      setStatus('succeeded');
    } catch (err) {
      setStatus('failed');
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="ml-7 mt-2 space-y-2 rounded-md border border-[var(--color-border)] p-3">
      <div>
        <div className="text-sm font-medium">Update infra baseline</div>
        <div className="text-xs text-[var(--color-muted-foreground)]">
          Re-run phase 1 against the cluster&apos;s installer stack to apply infra changes that ship with the bundled
          @appliance.sh/infra package (state bucket policy, ECR, CloudFront, edge router, system roles, etc.). The
          running api-server keeps its cached APPLIANCE_BASE_CONFIG until its next deploy — run an api-server update
          afterwards to propagate any baseline value changes.
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 text-xs">
        <div>
          <span className="text-[var(--color-muted-foreground)]">Running</span>
          <div className="font-mono">
            {clusterInfoQuery.isLoading ? (
              <span className="text-[var(--color-muted-foreground)]">…</span>
            ) : runningBaselineVersion ? (
              runningBaselineVersion
            ) : (
              <span
                className="text-[var(--color-muted-foreground)]"
                title="baselineVersion missing — cluster predates the field"
              >
                unknown
              </span>
            )}
          </div>
        </div>
        <div>
          <span className="text-[var(--color-muted-foreground)]">Bundled with this shell</span>
          <div className="font-mono">{bundledVersion}</div>
        </div>
      </div>

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

      {!cluster.lastBootstrapInput ? (
        <div className="rounded-md border border-dashed border-[var(--color-border)] p-2 text-xs text-[var(--color-muted-foreground)]">
          No cached bootstrap input on this cluster — needed to preserve dns / vpc choices when re-running phase 1.
          Re-run <code className="font-mono">/bootstrap</code> from this device to cache it, or operate via the CLI.
        </div>
      ) : null}

      <div className="flex items-center gap-2">
        <Button size="sm" onClick={onRun} disabled={status === 'running' || !canUpdate}>
          {status === 'running' ? 'Updating…' : `Update baseline to ${bundledVersion}`}
        </Button>
        {status === 'succeeded' ? <span className="text-xs text-green-400">✓ Baseline updated</span> : null}
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

function UpdateApiServerPanel({ cluster }: { cluster: Cluster }) {
  const host = useHost();
  const client = useApplianceClient();
  const { config } = useSelectedCluster();
  const apiKey = config?.apiKey ?? null;
  const [status, setStatus] = React.useState<RunStatus>('idle');
  const [logs, setLogs] = React.useState<string[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const [awsProfile, setAwsProfile] = React.useState('');
  const [targetVersion, setTargetVersion] = React.useState('');
  const [baseConfigJson, setBaseConfigJson] = React.useState('');

  // Same cluster-info query the migration panels use — TanStack Query
  // dedupes by key so this doesn't generate a second request.
  const clusterInfoQuery = useQuery({
    queryKey: ['cluster-info', cluster.id],
    enabled: Boolean(client),
    queryFn: async () => {
      const r = await client!.getClusterInfo();
      if (!r.success) throw r.error;
      return r.data;
    },
    retry: false,
  });
  const runningVersion = clusterInfoQuery.data?.version ?? null;

  // Latest semver tag on ghcr.io/appliance-sh/api-server. Best-effort:
  // if the lookup fails (no network, package private, etc.) the user
  // can still type a version manually.
  const latestQuery = useQuery({
    queryKey: ['ghcr-latest', 'appliance-sh/api-server'],
    enabled: Boolean(host.bootstrap?.latestApiServerVersion),
    queryFn: async () => host.bootstrap!.latestApiServerVersion!(),
    retry: false,
    staleTime: 60_000,
  });
  const latestVersion = latestQuery.data?.version ?? null;

  // Default the input to whatever we know: latest from GHCR, else the
  // running version (so the user can re-pin), else empty.
  React.useEffect(() => {
    if (targetVersion) return;
    if (latestVersion) setTargetVersion(latestVersion);
    else if (runningVersion) setTargetVersion(runningVersion);
  }, [latestVersion, runningVersion, targetVersion]);

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
        setLogs((prev) => [...prev, `phase failed: ${e.error}`]);
        break;
      case 'resource':
        if (e.op === 'same') return;
        setLogs((prev) => [...prev, `${e.op.padEnd(7)} ${e.resourceType}  ${e.name}`]);
        break;
      default:
        break;
    }
  }, []);

  const targetValid = /^\d+\.\d+\.\d+$/.test(targetVersion);
  // Older api-server images (deployed before /cluster-info shipped) 404
  // the cluster-info route. The user can fall back to pasting the
  // APPLIANCE_BASE_CONFIG env var directly. We only require the paste
  // when the query has actually errored — TanStack's `isError` covers
  // 4xx/5xx + network failures.
  const clusterInfoUnavailable = clusterInfoQuery.isError;
  const parsedOverride = React.useMemo<ApplianceBaseConfig | null>(() => {
    if (!baseConfigJson.trim()) return null;
    try {
      return applianceBaseConfig.parse(JSON.parse(baseConfigJson));
    } catch {
      return null;
    }
  }, [baseConfigJson]);
  const overrideValid = !clusterInfoUnavailable || parsedOverride !== null;

  const onRun = async () => {
    if (!targetValid) return;
    if (!overrideValid) return;
    if (!host.bootstrap?.updateApiServer) return;
    if (!apiKey) {
      setStatus('failed');
      setError('No API key loaded for this cluster — switch to it first.');
      return;
    }
    setStatus('running');
    setLogs([]);
    setError(null);
    try {
      await host.bootstrap.updateApiServer(
        {
          apiServerUrl: cluster.apiServerUrl,
          apiKey,
          targetVersion,
          awsProfile: awsProfile || undefined,
          baseConfigOverride: clusterInfoUnavailable ? (parsedOverride ?? undefined) : undefined,
        },
        undefined,
        handleEvent
      );
      setStatus('succeeded');
    } catch (err) {
      setStatus('failed');
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="ml-7 mt-2 space-y-2 rounded-md border border-[var(--color-border)] p-3">
      <div>
        <div className="text-sm font-medium">Update api-server / api-worker</div>
        <div className="text-xs text-[var(--color-muted-foreground)]">
          Mirror a new <code className="font-mono">ghcr.io/appliance-sh/api-server</code> tag into this cluster&apos;s
          ECR and redeploy the system Lambdas. Worker is updated first; the api-server&apos;s deploy goes through the
          (now upgraded) worker.
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 text-xs">
        <div>
          <span className="text-[var(--color-muted-foreground)]">Running</span>
          <div className="font-mono">
            {clusterInfoQuery.isLoading ? (
              <span className="text-[var(--color-muted-foreground)]">…</span>
            ) : runningVersion ? (
              runningVersion
            ) : (
              <span className="text-[var(--color-muted-foreground)]" title="version field missing from /cluster-info">
                unknown
              </span>
            )}
          </div>
        </div>
        <div>
          <span className="text-[var(--color-muted-foreground)]">Latest on ghcr.io</span>
          <div className="font-mono">
            {latestQuery.isLoading ? (
              <span className="text-[var(--color-muted-foreground)]">…</span>
            ) : latestVersion ? (
              latestVersion
            ) : (
              <span
                className="text-[var(--color-muted-foreground)]"
                title={latestQuery.error instanceof Error ? latestQuery.error.message : String(latestQuery.error ?? '')}
              >
                unavailable
              </span>
            )}
          </div>
        </div>
      </div>

      {clusterInfoUnavailable ? (
        <label className="block space-y-1 text-xs">
          <span className="text-[var(--color-muted-foreground)]">
            APPLIANCE_BASE_CONFIG (paste JSON — fallback when /cluster-info isn&apos;t available)
          </span>
          <textarea
            value={baseConfigJson}
            onChange={(e) => setBaseConfigJson(e.target.value)}
            disabled={status === 'running'}
            rows={6}
            spellCheck={false}
            placeholder={'{ "name": "...", "type": "appliance-base-aws-public", "stateBackendUrl": "s3://...", ... }'}
            className="w-full rounded-md border border-[var(--color-border)] bg-transparent px-2 py-1.5 font-mono text-xs disabled:opacity-50"
          />
          <span className="text-[var(--color-muted-foreground)]">
            Recover via{' '}
            <code className="font-mono">
              aws lambda get-function-configuration --function-name &lt;api-server-handler&gt; --query
              &apos;Environment.Variables.APPLIANCE_BASE_CONFIG&apos; --output text
            </code>
            . Required only on first update from a pre-/cluster-info api-server.
          </span>
          {baseConfigJson.trim() && parsedOverride === null ? (
            <span className="text-red-400">
              Invalid JSON or schema mismatch — couldn&apos;t parse as ApplianceBaseConfig.
            </span>
          ) : null}
        </label>
      ) : null}

      <label className="block space-y-1 text-xs">
        <span className="text-[var(--color-muted-foreground)]">Target version</span>
        <input
          type="text"
          value={targetVersion}
          onChange={(e) => setTargetVersion(e.target.value)}
          placeholder="1.37.0"
          disabled={status === 'running'}
          spellCheck={false}
          className="w-full rounded-md border border-[var(--color-border)] bg-transparent px-2 py-1.5 font-mono text-sm disabled:opacity-50"
        />
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
        <Button size="sm" onClick={onRun} disabled={status === 'running' || !targetValid || !overrideValid}>
          {status === 'running' ? 'Updating…' : `Update to ${targetVersion || '…'}`}
        </Button>
        {status === 'succeeded' ? <span className="text-xs text-green-400">✓ Update complete</span> : null}
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
  const client = useApplianceClient();
  const { config } = useSelectedCluster();
  const apiKey = config?.apiKey ?? null;
  const [status, setStatus] = React.useState<RunStatus>('idle');
  const [logs, setLogs] = React.useState<string[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const [awsProfile, setAwsProfile] = React.useState('');

  // Pull the cluster's state backend URL from the api-server's
  // base config rather than asking the user to paste it. The bucket
  // is created by `applianceBase` and recorded as `stateBackendUrl`
  // in APPLIANCE_BASE_CONFIG; `/api/v1/cluster-info` exposes it.
  const clusterInfoQuery = useQuery({
    queryKey: ['cluster-info', cluster.id],
    enabled: Boolean(client),
    queryFn: async () => {
      const r = await client!.getClusterInfo();
      if (!r.success) throw r.error;
      return r.data;
    },
  });
  const stateBackendUrl = clusterInfoQuery.data?.baseConfig.stateBackendUrl ?? '';
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
        {
          stateBackendUrl,
          awsProfile: awsProfile || undefined,
          // Cluster ref lets the bootstrap pkg verify the URL we're
          // about to operate on against /cluster-info. This panel
          // already sources stateBackendUrl from cluster-info via
          // the same client, so the verification is effectively a
          // belt + braces check — but it covers the path where the
          // sidecar is fed a different value somehow (compromised
          // IPC, future caller changes).
          cluster: apiKey ? { apiServerUrl: cluster.apiServerUrl, apiKey } : undefined,
        },
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

      <div className="space-y-1 text-xs">
        <span className="text-[var(--color-muted-foreground)]">State backend</span>
        <div className="rounded-md border border-[var(--color-border)] bg-black/20 px-2 py-1.5 font-mono text-sm">
          {clusterInfoQuery.isLoading ? (
            <span className="text-[var(--color-muted-foreground)]">Loading from api-server…</span>
          ) : clusterInfoQuery.isError ? (
            <span className="text-red-400">
              Failed to read /api/v1/cluster-info:{' '}
              {clusterInfoQuery.error instanceof Error
                ? clusterInfoQuery.error.message
                : String(clusterInfoQuery.error)}
            </span>
          ) : stateBackendUrl ? (
            stateBackendUrl
          ) : (
            <span className="text-[var(--color-muted-foreground)]">no stateBackendUrl in cluster info</span>
          )}
        </div>
        <span className="text-[var(--color-muted-foreground)]">
          Read from <code className="font-mono">/api/v1/cluster-info</code> — this is the bucket{' '}
          <code className="font-mono">applianceBase</code> created for the cluster.
        </span>
      </div>

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

/**
 * Destroy the cluster's base AWS infrastructure from the desktop — the
 * inverse of the bootstrap wizard. Drives `host.bootstrap.teardown`,
 * which runs `pulumi destroy` against the installer state cached in
 * `~/.appliance`. Gated (by the caller) to clusters this device
 * bootstrapped. On success the local registration is forgotten so the
 * dead cluster drops off the list.
 */
function DestroyClusterPanel({ cluster }: { cluster: Cluster }) {
  const host = useHost();
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const { toast } = useToast();
  const [status, setStatus] = React.useState<RunStatus>('idle');
  const [logs, setLogs] = React.useState<string[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const [awsProfile, setAwsProfile] = React.useState('');

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
        setLogs((prev) => [...prev, `phase failed: ${e.error}`]);
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
    if (!host.bootstrap?.teardown) return;
    const ok = await confirm({
      title: `Destroy cluster "${cluster.name}"?`,
      description:
        'This runs pulumi destroy against the installer stack and tears down every base AWS resource it created ' +
        '(Route53 zone, CloudFront distribution, ACM certificate, edge router Lambda, S3 state + data buckets, ECR ' +
        'repository, IAM roles). User-deployed appliances live in a separate project and are NOT destroyed — destroy ' +
        'them first or their AWS resources will be orphaned. This cannot be undone.',
      confirmLabel: 'Destroy cluster',
    });
    if (!ok) return;
    setStatus('running');
    setLogs([]);
    setError(null);
    try {
      await host.bootstrap.teardown({ awsProfile: awsProfile || undefined }, handleEvent);
      setStatus('succeeded');
      toast(`Cluster "${cluster.name}" destroyed`);
      // The infra is gone, so the local (URL, key) registration is now
      // stale — forget it so the dead cluster drops off the list. Best
      // effort: a failure to forget doesn't undo the successful destroy.
      try {
        await host.removeCluster(cluster.id);
        await queryClient.invalidateQueries({ queryKey: ['host', 'config'] });
      } catch {
        // Leave the row in place; the user can remove it manually.
      }
    } catch (err) {
      setStatus('failed');
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="ml-7 mt-2 space-y-2 rounded-md border border-red-500/40 p-3">
      <div>
        <div className="text-sm font-medium text-red-400">Destroy cluster</div>
        <div className="text-xs text-[var(--color-muted-foreground)]">
          Tear down this cluster&apos;s base AWS infrastructure (the inverse of bootstrap) using the installer state on
          this device. Destroy any deployed appliances first — they live in a separate Pulumi project and would
          otherwise be orphaned. The local Pulumi state is archived, so the operation is reversible if something was
          torn down by mistake.
        </div>
      </div>

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
        <Button variant="destructive" size="sm" onClick={onRun} disabled={status === 'running'}>
          <Trash2 className="h-4 w-4" />
          {status === 'running' ? 'Destroying…' : 'Destroy cluster'}
        </Button>
        {status === 'succeeded' ? <span className="text-xs text-green-400">✓ Cluster destroyed</span> : null}
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

type UpdatePhase = 'idle' | 'checking' | 'available' | 'up-to-date' | 'downloading' | 'ready' | 'failed';

/**
 * Self-update panel for the desktop shell. Drives the Tauri updater
 * through `host.updater`: check the signed feed, download+install the
 * new bundle with a progress bar, then offer a relaunch into it. Only
 * rendered when `host.updater` exists (desktop-only).
 */
function UpdatesSection() {
  const host = useHost();
  const { toast } = useToast();
  const [phase, setPhase] = React.useState<UpdatePhase>('idle');
  const [update, setUpdate] = React.useState<AvailableUpdate | null>(null);
  const [progress, setProgress] = React.useState<UpdateProgress | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const onCheck = async () => {
    if (!host.updater) return;
    setPhase('checking');
    setError(null);
    setProgress(null);
    try {
      const found = await host.updater.check();
      if (found) {
        setUpdate(found);
        setPhase('available');
      } else {
        setUpdate(null);
        setPhase('up-to-date');
      }
    } catch (err) {
      setPhase('failed');
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const onInstall = async () => {
    if (!host.updater) return;
    setPhase('downloading');
    setError(null);
    setProgress({ downloaded: 0 });
    try {
      await host.updater.downloadAndInstall((p) => setProgress(p));
      setPhase('ready');
      toast(`Update ${update?.version ?? ''} installed — restart to apply`.trim());
    } catch (err) {
      setPhase('failed');
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const onRelaunch = async () => {
    if (!host.updater) return;
    try {
      await host.updater.relaunch();
    } catch (err) {
      // A failed relaunch isn't fatal — the update is already installed
      // and will apply on the next manual restart. Surface it but keep
      // the "ready" state so the user can retry or quit themselves.
      setError(err instanceof Error ? err.message : String(err));
      toast('Could not restart automatically — quit and reopen to finish updating', { variant: 'error' });
    }
  };

  const pct =
    progress && progress.contentLength
      ? Math.min(100, Math.round((progress.downloaded / progress.contentLength) * 100))
      : null;

  return (
    <Section title="Updates" description="Check for a newer signed build and install it in place.">
      <div className="space-y-3">
        <div className="grid grid-cols-[auto_1fr] items-baseline gap-4">
          <dt className="text-xs text-[var(--color-muted-foreground)]">Installed</dt>
          <dd className="text-sm">
            <code className="font-mono text-xs">{__APPLIANCE_VERSION__}</code>
          </dd>
        </div>

        {phase === 'available' && update ? (
          <div className="grid grid-cols-[auto_1fr] items-baseline gap-4">
            <dt className="text-xs text-[var(--color-muted-foreground)]">Available</dt>
            <dd className="text-sm">
              <code className="font-mono text-xs text-[var(--color-accent)]">{update.version}</code>
              {update.date ? (
                <span className="ml-2 text-xs text-[var(--color-muted-foreground)]">
                  {new Date(update.date).toLocaleDateString()}
                </span>
              ) : null}
            </dd>
          </div>
        ) : null}

        {phase === 'available' && update?.notes ? (
          <div className="rounded-md border border-[var(--color-border)] bg-black/20 px-3 py-2 text-xs whitespace-pre-wrap text-[var(--color-muted-foreground)]">
            {update.notes}
          </div>
        ) : null}

        {phase === 'downloading' ? (
          <div className="space-y-1">
            <div className="h-2 w-full overflow-hidden rounded-full bg-[var(--color-border)]">
              <div
                className={cn('h-full bg-[var(--color-accent)] transition-all', pct === null && 'animate-pulse w-1/3')}
                style={pct === null ? undefined : { width: `${pct}%` }}
              />
            </div>
            <div className="text-xs text-[var(--color-muted-foreground)]">
              {pct === null ? 'Downloading…' : `Downloading ${pct}%`}
            </div>
          </div>
        ) : null}

        <div className="flex items-center gap-2">
          {phase === 'available' ? (
            <Button size="sm" onClick={onInstall}>
              <Download className="h-4 w-4" /> Download &amp; install {update?.version}
            </Button>
          ) : phase === 'ready' ? (
            <Button size="sm" onClick={onRelaunch}>
              <ArrowUpCircle className="h-4 w-4" /> Restart to update
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              onClick={onCheck}
              disabled={phase === 'checking' || phase === 'downloading'}
            >
              <RefreshCw className={cn('h-4 w-4', phase === 'checking' && 'animate-spin')} />
              {phase === 'checking' ? 'Checking…' : 'Check for updates'}
            </Button>
          )}

          {phase === 'up-to-date' ? (
            <span className="text-xs text-green-400">✓ You&apos;re on the latest version</span>
          ) : null}
          {phase === 'ready' ? <span className="text-xs text-green-400">✓ Installed</span> : null}
          {phase === 'failed' ? <span className="text-xs text-red-400">Update failed</span> : null}
        </div>

        {error ? (
          <div className="rounded-md border border-[var(--color-border)] bg-black/30 px-3 py-2 font-mono text-xs whitespace-pre-wrap text-red-400">
            {error}
          </div>
        ) : null}
      </div>
    </Section>
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
