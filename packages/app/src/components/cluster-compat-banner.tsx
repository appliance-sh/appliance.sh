import * as React from 'react';
import { Link } from 'react-router';
import { AlertTriangle } from 'lucide-react';
import { useClusterCompat } from '@/hooks/use-cluster-compat';

// Cluster-level version-compat banner (generalized from the deploy
// wizard's capability banner): one amber line at the top of the shell
// when the selected cluster's control plane and this app have drifted
// apart, with the remediation that actually applies. Also surfaces the
// server's operational `warnings[]` (e.g. the guest watchdog's "legacy
// deploy removed — update the CLI") verbatim. Renders nothing when
// versions agree and no warnings exist, while data is loading, and for
// cloud clusters whose (independent) version merely differs.

export function ClusterCompatBanner() {
  const compat = useClusterCompat();
  if (compat.loading) return null;

  let message: React.ReactNode = null;
  if (compat.clientBelowMinimum) {
    message = (
      <>
        This app (v{compat.clientVersion}) is older than the server&apos;s minimum supported client (v
        {compat.minClientVersion}) — update the app, then reload.
      </>
    );
  } else if (compat.controlPlanePredatesReporting) {
    message = (
      <>
        The Dev Machine&apos;s control plane predates capability reporting — restart the Dev Machine from the{' '}
        <Link to="/machine" className="underline">
          Machine page
        </Link>{' '}
        to update it.
      </>
    );
  } else if (compat.versionDrift && compat.isMicroVm) {
    message = (
      <>
        The Dev Machine&apos;s control plane (v{compat.serverVersion}) doesn&apos;t match this app (v
        {compat.clientVersion}) — restart the Dev Machine from the{' '}
        <Link to="/machine" className="underline">
          Machine page
        </Link>{' '}
        to update it.
      </>
    );
  }
  // Server-reported operational warnings ride the same banner, one
  // line each, straight through (already deduplicated by the hook).
  if (!message && compat.warnings.length === 0) return null;

  return (
    <div
      role="status"
      className="mb-4 flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-amber-200"
    >
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span className="flex flex-col gap-1">
        {message ? <span>{message}</span> : null}
        {compat.warnings.map((warning) => (
          <span key={warning}>{warning}</span>
        ))}
      </span>
    </div>
  );
}
