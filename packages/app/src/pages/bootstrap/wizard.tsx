import * as React from 'react';
import { useNavigate } from 'react-router';
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

export interface WizardValues {
  name: string;
  region: string;
  domain: string;
  createZone: boolean;
}

export function BootstrapWizardPage() {
  const host = useHost();
  const navigate = useNavigate();

  const [name, setName] = React.useState('appliance');
  const [region, setRegion] = React.useState('us-east-1');
  const [domain, setDomain] = React.useState('');
  const [createZone, setCreateZone] = React.useState(true);

  const canSubmit = name.length > 0 && domain.includes('.');
  const bootstrapAvailable = Boolean(host.bootstrap);

  if (!bootstrapAvailable) {
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

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    const values: WizardValues = { name, region, domain, createZone };
    navigate('/bootstrap/run', { state: values });
  };

  return (
    <div className="mx-auto max-w-md space-y-6 pt-12">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold">New installation</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Provision the base AWS infrastructure for a new Appliance cluster. Uses the AWS credentials from your current
          shell environment.
        </p>
      </div>

      <form className="space-y-4" onSubmit={onSubmit}>
        <Field label="Base name" hint="lowercase letters, digits, dashes">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            pattern="[a-z][a-z0-9-]*"
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

        <Button type="submit" disabled={!canSubmit} className="w-full">
          Start bootstrap
        </Button>
      </form>
    </div>
  );
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
