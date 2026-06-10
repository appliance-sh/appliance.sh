import * as React from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Cloud, ChevronLeft, Laptop } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useHost } from '@/providers/host-provider';

const REGIONS = [
  'us-east-1',
  'us-east-2',
  'us-west-1',
  'us-west-2',
  'eu-west-1',
  'eu-west-2',
  'eu-central-1',
  'ap-southeast-1',
  'ap-southeast-2',
  'ap-northeast-1',
  'ap-northeast-2',
  'ap-south-1',
];

/**
 * Discriminator for the two bootstrap paths the wizard now drives.
 *
 *   - 'aws'   : the existing 3-phase Pulumi flow (installer stack +
 *               api-server + state promotion). Targets a cloud
 *               install reachable from anywhere.
 *   - 'local' : a single-step setup that spins up the desktop's k3d
 *               cluster and in-process api-server. Targets a dev
 *               loop on the operator's own machine.
 *
 * Both modes funnel through `/bootstrap/run` which dispatches on this
 * field. The mode can be pre-selected via `?mode=local` (the
 * dashboard's "Local Runtime" card uses this to skip the picker).
 */
export type WizardMode = 'aws' | 'local';

export interface AwsWizardValues {
  mode: 'aws';
  name: string;
  region: string;
  domain: string;
  createZone: boolean;
  deployApiServer: boolean;
  // When true, the bootstrap also runs phase 3 (promote installer
  // Pulumi state from local file backend → cluster S3 backend) so
  // the install isn't tied to this device. Only meaningful when
  // deployApiServer is true; phase-1-only runs leave the installer
  // local on purpose. Settings can run phase 3 later if it's
  // skipped or fails.
  promoteState: boolean;
  apiServerImageUri?: string;
  awsProfile?: string;
}

export interface LocalWizardValues {
  mode: 'local';
  /** Optional cluster name override. Defaults to `appliance-local`. */
  clusterName?: string;
  /** Optional host port override for the k3d loadbalancer; default 8081. */
  hostPort?: number;
  /** Optional namespace override for in-cluster appliance workloads. */
  namespace?: string;
  /** Optional hostname suffix override; default `appliance.localhost`. */
  hostnameSuffix?: string;
}

export type WizardValues = AwsWizardValues | LocalWizardValues;

export function BootstrapWizardPage() {
  const host = useHost();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const bootstrapAvailable = Boolean(host.bootstrap);
  const localAvailable = Boolean(host.local?.startRuntime);

  // Read `?mode=` once so deep-linking from the dashboard (e.g.
  // `/bootstrap?mode=local`) skips the picker. Default to the picker.
  const presetMode = parseMode(searchParams.get('mode'), { aws: bootstrapAvailable, local: localAvailable });
  const [mode, setMode] = React.useState<WizardMode | null>(presetMode);

  if (!bootstrapAvailable && !localAvailable) {
    return (
      <div className="mx-auto max-w-md space-y-4 pt-16">
        <h1 className="text-2xl font-semibold">Bootstrap unavailable</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          This shell can&apos;t drive a bootstrap locally. Run{' '}
          <code className="rounded bg-[var(--color-muted)] px-1.5 py-0.5">appliance bootstrap</code> from the CLI, then
          connect to the resulting api-server URL.
        </p>
      </div>
    );
  }

  if (!mode) {
    return (
      <ModePicker
        awsAvailable={bootstrapAvailable}
        localAvailable={localAvailable}
        onPick={(m) => setMode(m)}
        onCancel={() => navigate('/')}
      />
    );
  }

  if (mode === 'aws') {
    return (
      <AwsForm
        onBack={presetMode ? null : () => setMode(null)}
        onSubmit={(values) => navigate('/bootstrap/run', { state: values })}
      />
    );
  }

  return (
    <LocalForm
      onBack={presetMode ? null : () => setMode(null)}
      onSubmit={(values) => navigate('/bootstrap/run', { state: values })}
    />
  );
}

// ---- mode picker ------------------------------------------------------

function ModePicker({
  awsAvailable,
  localAvailable,
  onPick,
  onCancel,
}: {
  awsAvailable: boolean;
  localAvailable: boolean;
  onPick: (mode: WizardMode) => void;
  onCancel: () => void;
}) {
  return (
    <div className="mx-auto max-w-2xl space-y-6 pt-12">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold">New installation</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Pick a target. Local runs entirely on this machine via a k3d cluster — perfect for development. AWS provisions
          a cloud-resident installation reachable from anywhere.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <ModeCard
          icon={Laptop}
          title="Local Runtime"
          body={
            <>
              Spin up a k3d cluster + in-process api-server on this device. Requires Docker. Apps publish at{' '}
              <code className="text-[11px]">&lt;project&gt;-&lt;env&gt;.appliance.localhost</code>.
            </>
          }
          available={localAvailable}
          disabledReason="Local Runtime needs the desktop app — the web shell can't drive k3d."
          onClick={() => onPick('local')}
        />
        <ModeCard
          icon={Cloud}
          title="AWS Cluster"
          body="Provision CloudFront + Lambda + Route53 on your account. Three Pulumi phases. Requires AWS credentials."
          available={awsAvailable}
          disabledReason="Bootstrap to AWS needs the desktop app or the CLI."
          onClick={() => onPick('aws')}
        />
      </div>

      <Button variant="ghost" onClick={onCancel}>
        <ChevronLeft className="h-4 w-4" /> Cancel
      </Button>
    </div>
  );
}

function ModeCard({
  icon: Icon,
  title,
  body,
  available,
  disabledReason,
  onClick,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  body: React.ReactNode;
  available: boolean;
  disabledReason: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={available ? onClick : undefined}
      disabled={!available}
      title={available ? undefined : disabledReason}
      className="flex flex-col items-start gap-2 rounded-md border border-[var(--color-border)] p-4 text-left transition-colors hover:bg-[var(--color-muted)] disabled:cursor-not-allowed disabled:opacity-50"
    >
      <Icon className="h-6 w-6 text-[var(--color-muted-foreground)]" />
      <div className="text-sm font-semibold">{title}</div>
      <div className="text-xs text-[var(--color-muted-foreground)]">{body}</div>
      {!available ? <div className="text-[10px] text-amber-300">{disabledReason}</div> : null}
    </button>
  );
}

function parseMode(raw: string | null, capability: { aws: boolean; local: boolean }): WizardMode | null {
  if (raw === 'aws' && capability.aws) return 'aws';
  if (raw === 'local' && capability.local) return 'local';
  return null;
}

// ---- local form -------------------------------------------------------

function LocalForm({
  onBack,
  onSubmit,
}: {
  onBack: (() => void) | null;
  onSubmit: (values: LocalWizardValues) => void;
}) {
  const [clusterName, setClusterName] = React.useState('');
  const [hostPort, setHostPort] = React.useState('');
  const [namespace, setNamespace] = React.useState('');
  const [hostnameSuffix, setHostnameSuffix] = React.useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const parsedPort = hostPort ? Number.parseInt(hostPort, 10) : NaN;
    onSubmit({
      mode: 'local',
      clusterName: clusterName || undefined,
      hostPort: Number.isFinite(parsedPort) ? parsedPort : undefined,
      namespace: namespace || undefined,
      hostnameSuffix: hostnameSuffix || undefined,
    });
  };

  return (
    <div className="mx-auto max-w-md space-y-6 pt-12">
      {onBack ? (
        <Button variant="ghost" size="sm" className="-ml-2" onClick={onBack}>
          <ChevronLeft className="h-4 w-4" /> Back
        </Button>
      ) : null}

      <div className="space-y-2">
        <h1 className="text-2xl font-semibold">Local Runtime</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Defaults are fine for most setups — Start brings up a k3d cluster, launches the api-server, and registers it
          with the Console. Override any field if you already use the defaults for something else.
        </p>
      </div>

      <form className="space-y-4" onSubmit={handleSubmit}>
        <Field label="Cluster name" hint="default: appliance-local">
          <input
            type="text"
            value={clusterName}
            onChange={(e) => setClusterName(e.target.value)}
            placeholder="appliance-local"
            className={inputCls}
          />
        </Field>

        <Field label="Host port" hint="default: 8081 — the k3d loadbalancer publishes Traefik here">
          <input
            type="number"
            value={hostPort}
            onChange={(e) => setHostPort(e.target.value)}
            placeholder="8081"
            min="1"
            max="65535"
            className={inputCls}
          />
        </Field>

        <Field label="Namespace" hint="default: appliance">
          <input
            type="text"
            value={namespace}
            onChange={(e) => setNamespace(e.target.value)}
            placeholder="appliance"
            className={inputCls}
          />
        </Field>

        <Field label="Hostname suffix" hint="default: appliance.localhost — must auto-resolve to 127.0.0.1">
          <input
            type="text"
            value={hostnameSuffix}
            onChange={(e) => setHostnameSuffix(e.target.value)}
            placeholder="appliance.localhost"
            className={inputCls}
          />
        </Field>

        <Button type="submit" className="w-full">
          Start
        </Button>
      </form>
    </div>
  );
}

// ---- aws form ---------------------------------------------------------

function AwsForm({ onBack, onSubmit }: { onBack: (() => void) | null; onSubmit: (values: AwsWizardValues) => void }) {
  const host = useHost();
  const [name, setName] = React.useState('appliance');
  const [region, setRegion] = React.useState('us-east-1');
  const [domain, setDomain] = React.useState('');
  const [createZone, setCreateZone] = React.useState(true);
  const [deployApiServer, setDeployApiServer] = React.useState(false);
  const [promoteState, setPromoteState] = React.useState(true);
  const [apiServerImageUri, setApiServerImageUri] = React.useState('');
  const [awsProfile, setAwsProfile] = React.useState('');

  // List AWS profiles from ~/.aws/{config,credentials}. Tauri reads
  // the files; web shell omits the capability and the wizard falls
  // back to a free-text input.
  const profilesQuery = useQuery({
    queryKey: ['aws-profiles'],
    enabled: Boolean(host.bootstrap?.listAwsProfiles),
    queryFn: () => host.bootstrap!.listAwsProfiles!(),
  });
  const profiles = profilesQuery.data ?? [];
  const canEnumerateProfiles = Boolean(host.bootstrap?.listAwsProfiles);

  // Default to "default" if the user has it; otherwise leave empty
  // (operator's shell env wins as the credential source).
  React.useEffect(() => {
    if (awsProfile) return;
    if (profiles.some((p) => p.name === 'default')) setAwsProfile('default');
  }, [profiles, awsProfile]);

  // Image URI is fully optional — phase 2 falls back to the pinned
  // ghcr.io/appliance-sh/api-server:<version> default. If the user
  // types something, it must at least look like a registry reference.
  const imageUriValid = apiServerImageUri.length === 0 || apiServerImageUri.includes('/');
  const canSubmit = name.length > 0 && domain.includes('.') && imageUriValid;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    onSubmit({
      mode: 'aws',
      name,
      region,
      domain,
      createZone,
      deployApiServer,
      // Phase 3 only makes sense when an api-server is being deployed
      // — phase-1-only runs are explicitly local-state.
      promoteState: deployApiServer && promoteState,
      apiServerImageUri: deployApiServer && apiServerImageUri ? apiServerImageUri : undefined,
      awsProfile: awsProfile || undefined,
    });
  };

  return (
    <div className="mx-auto max-w-md space-y-6 pt-12">
      {onBack ? (
        <Button variant="ghost" size="sm" className="-ml-2" onClick={onBack}>
          <ChevronLeft className="h-4 w-4" /> Back
        </Button>
      ) : null}

      <div className="space-y-2">
        <h1 className="text-2xl font-semibold">AWS Cluster</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Provision the base AWS infrastructure for a new Appliance cluster. AWS credentials are sourced from the
          selected profile (or your shell environment if none is selected).
        </p>
      </div>

      <form className="space-y-4" onSubmit={handleSubmit}>
        <Field
          label="AWS profile"
          hint={canEnumerateProfiles ? '~/.aws/config + credentials' : 'shell env will be used'}
        >
          {canEnumerateProfiles ? (
            <select value={awsProfile} onChange={(e) => setAwsProfile(e.target.value)} className={inputCls}>
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
              className={`${inputCls} font-mono`}
            />
          )}
        </Field>

        <Field label="Base name" hint="lowercase letters, digits, dashes">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            pattern="[a-z][a-z0-9\-]*"
            required
            className={inputCls}
          />
        </Field>

        <Field label="AWS region">
          <select value={region} onChange={(e) => setRegion(e.target.value)} className={inputCls}>
            {REGIONS.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Domain" hint="example.appliance.sh">
          <input
            type="text"
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
            placeholder="example.appliance.sh"
            required
            className={inputCls}
          />
        </Field>

        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={createZone} onChange={(e) => setCreateZone(e.target.checked)} />
          <span>Create a new Route53 zone for this domain</span>
        </label>

        <div className="space-y-3 rounded-md border border-[var(--color-border)] p-3">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={deployApiServer} onChange={(e) => setDeployApiServer(e.target.checked)} />
            <span>Also deploy api-server (phase 2)</span>
          </label>
          {deployApiServer ? (
            <>
              <Field label="API server image (override)" hint="optional — defaults to ghcr.io/appliance-sh/api-server">
                <input
                  type="text"
                  value={apiServerImageUri}
                  onChange={(e) => setApiServerImageUri(e.target.value)}
                  placeholder="ghcr.io/appliance-sh/api-server:latest"
                  className={`${inputCls} font-mono`}
                />
              </Field>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={promoteState}
                  onChange={(e) => setPromoteState(e.target.checked)}
                  className="mt-0.5"
                />
                <span>
                  Promote installer state to S3 (phase 3) — recommended; you can re-bootstrap from any device.
                </span>
              </label>
            </>
          ) : null}
        </div>

        <Button type="submit" disabled={!canSubmit} className="w-full">
          Start
        </Button>
      </form>
    </div>
  );
}

// ---- shared form bits -------------------------------------------------

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="block text-xs font-medium uppercase tracking-wide text-[var(--color-muted-foreground)]">
        {label}
      </span>
      {children}
      {hint ? <span className="block text-[10px] text-[var(--color-muted-foreground)]">{hint}</span> : null}
    </label>
  );
}

const inputCls =
  'w-full rounded-md border border-[var(--color-border)] bg-transparent px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]';
