import * as React from 'react';
import { useLocation, useNavigate, Navigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { ApplianceBaseType } from '@appliance.sh/sdk/models';
import { Button } from '@/components/ui/button';
import { useHost } from '@/providers/host-provider';
import type {
  BootstrapEvent,
  BootstrapInput,
  BootstrapPhase,
  BootstrapPriorOutputs,
  BootstrapResult,
} from '@/lib/host';
import type { WizardValues } from './wizard';
import { cn } from '@/lib/utils';

type PhaseState = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

const PHASE_ORDER: BootstrapPhase[] = ['phase1', 'phase2', 'phase3'];

interface LogLine {
  id: number;
  level: 'info' | 'warn' | 'error';
  message: string;
}

type HandoffState = 'idle' | 'saving' | 'saved' | 'failed' | 'skipped';

export function BootstrapProgressPage() {
  const host = useHost();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { state } = useLocation();
  const values = state as WizardValues | undefined;

  const [phases, setPhases] = React.useState<Record<BootstrapPhase, PhaseState>>({
    phase1: 'pending',
    phase2: 'pending',
    phase3: 'pending',
  });
  const [logs, setLogs] = React.useState<LogLine[]>([]);
  const [result, setResult] = React.useState<BootstrapResult | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [failedPhase, setFailedPhase] = React.useState<BootstrapPhase | null>(null);
  const [retrying, setRetrying] = React.useState(false);
  const [handoff, setHandoff] = React.useState<HandoffState>('idle');
  const [handoffError, setHandoffError] = React.useState<string | null>(null);
  const startedRef = React.useRef(false);
  const handoffStartedRef = React.useRef(false);
  const logIdRef = React.useRef(0);
  // Captured outputs of phases that have succeeded so far. Seeded
  // back into the engine on retry so phase 2 doesn't have to re-run
  // phase 1, etc.
  const priorRef = React.useRef<BootstrapPriorOutputs>({});
  // The exact BootstrapInput used for the original run. Reused
  // verbatim on retry — must not change between attempts or the
  // Pulumi stack would diverge from prior outputs.
  const inputRef = React.useRef<BootstrapInput | null>(null);
  // Phases the user originally asked for (e.g. ['phase1', 'phase2'])
  // — retry from phase N replays this list filtered to N onwards.
  const requestedRef = React.useRef<BootstrapPhase[]>([]);

  const appendLog = React.useCallback((level: LogLine['level'], message: string) => {
    logIdRef.current += 1;
    setLogs((prev) => [...prev, { id: logIdRef.current, level, message }]);
  }, []);

  const handleEvent = React.useCallback(
    (e: BootstrapEvent) => {
      switch (e.type) {
        case 'phase-started':
          setPhases((p) => ({ ...p, [e.phase]: 'running' }));
          break;
        case 'phase-completed':
          setPhases((p) => ({ ...p, [e.phase]: 'completed' }));
          break;
        case 'phase-failed':
          setPhases((p) => ({ ...p, [e.phase]: 'failed' }));
          setFailedPhase(e.phase);
          appendLog('error', `${e.phase}: ${e.error}`);
          break;
        case 'phase-skipped':
          // Don't visually demote a phase that has already
          // completed — on retry, the engine emits "skipped" for
          // phases not in the retry's phases list, which would
          // otherwise overwrite the green checkmark.
          setPhases((p) => (p[e.phase] === 'completed' ? p : { ...p, [e.phase]: 'skipped' }));
          break;
        case 'phase-output':
          if (e.phase === 'phase1') priorRef.current.phase1 = e.output;
          else if (e.phase === 'phase2') priorRef.current.phase2 = e.output;
          break;
        case 'resource':
          if (e.op === 'same') return;
          appendLog('info', `${e.op.padEnd(7)} ${e.resourceType}  ${e.name}`);
          break;
        case 'log':
          appendLog(e.level, e.message);
          break;
      }
    },
    [appendLog]
  );

  const runFrom = React.useCallback(
    (fromPhase: BootstrapPhase) => {
      const input = inputRef.current;
      if (!input || !host.bootstrap) return;
      const startIdx = PHASE_ORDER.indexOf(fromPhase);
      const phasesToRun = requestedRef.current.filter((p) => PHASE_ORDER.indexOf(p) >= startIdx);
      if (phasesToRun.length === 0) return;

      // Reset UI state for phases we're about to (re-)run.
      setPhases((p) => {
        const next = { ...p };
        for (const ph of phasesToRun) next[ph] = 'pending';
        return next;
      });
      setError(null);
      setFailedPhase(null);
      setRetrying(true);

      host.bootstrap
        .run(input, { phases: phasesToRun, prior: priorRef.current }, handleEvent)
        .then((r) => setResult(r))
        .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
        .finally(() => setRetrying(false));
    },
    [host.bootstrap, handleEvent]
  );

  React.useEffect(() => {
    if (!values || !host.bootstrap || startedRef.current) return;
    startedRef.current = true;

    inputRef.current = {
      base: {
        name: values.name,
        config: {
          type: ApplianceBaseType.ApplianceAwsPublic,
          name: values.name,
          region: values.region,
          dns: {
            domainName: values.domain,
            createZone: values.createZone,
            attachZone: !values.createZone,
          },
        },
      },
      apiServerImageUri: values.apiServerImageUri,
      aws: values.awsProfile ? { profile: values.awsProfile } : undefined,
    };
    const phases: BootstrapPhase[] = ['phase1'];
    if (values.deployApiServer) phases.push('phase2');
    if (values.promoteState) phases.push('phase3');
    requestedRef.current = phases;

    runFrom('phase1');
  }, [values, host.bootstrap, runFrom]);

  // Handoff: once bootstrap returns a reachable api-server + fresh
  // API key, persist them to the host (OS keychain in Tauri,
  // sessionStorage in the web shell) and invalidate the cached
  // config query so Dashboard/Settings re-read the connected state.
  // Phase 1–only results have no apiKey/apiServerUrl — nothing to
  // save, handoff marks itself `skipped`.
  React.useEffect(() => {
    if (!result || handoffStartedRef.current) return;
    handoffStartedRef.current = true;

    if (!result.apiServerUrl || !result.apiKey) {
      setHandoff('skipped');
      return;
    }

    const apiServerUrl = result.apiServerUrl;
    const apiKey = result.apiKey;
    const clusterName = values?.name ?? deriveNameFromUrl(apiServerUrl);
    // Persist stateBackendUrl onto the cluster only if phase 3
    // didn't already promote it. After promotion the local state
    // is gone, so a Settings-page promote action would have nothing
    // to do — and the cluster doesn't need to track the backend URL
    // for any other reason. Stash the BootstrapInput regardless,
    // since baseline updates need it to preserve dns/vpc choices.
    const stateBackendUrl = result.statePromoted ? undefined : result.stateBackendUrl || undefined;
    const bootstrapInput = inputRef.current ?? undefined;
    setHandoff('saving');
    (async () => {
      try {
        await host.addCluster({
          name: clusterName,
          apiServerUrl,
          apiKey,
          stateBackendUrl,
          lastBootstrapInput: bootstrapInput,
        });
        await queryClient.invalidateQueries({ queryKey: ['host', 'config'] });
        setHandoff('saved');
      } catch (err) {
        setHandoff('failed');
        setHandoffError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, [result, host, queryClient, values?.name]);

  if (!values) {
    return <Navigate to="/bootstrap" replace />;
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6 pt-8">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold">Bootstrapping {values.name}</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          {values.region} · {values.domain}
        </p>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <PhaseCard
          phase="phase1"
          label="Base infrastructure"
          state={phases.phase1}
          canRetry={failedPhase === 'phase1' && !retrying}
          onRetry={() => runFrom('phase1')}
        />
        <PhaseCard
          phase="phase2"
          label="API server"
          state={phases.phase2}
          canRetry={failedPhase === 'phase2' && !retrying}
          onRetry={() => runFrom('phase2')}
        />
        <PhaseCard
          phase="phase3"
          label="Promote state"
          state={phases.phase3}
          canRetry={failedPhase === 'phase3' && !retrying}
          onRetry={() => runFrom('phase3')}
        />
      </div>

      <div className="rounded-md border border-[var(--color-border)] bg-black/30">
        <div className="border-b border-[var(--color-border)] px-3 py-2 text-xs uppercase tracking-wide text-[var(--color-muted-foreground)]">
          Event log
        </div>
        <div className="h-80 overflow-auto font-mono text-xs leading-relaxed">
          {logs.length === 0 ? (
            <div className="px-3 py-4 text-[var(--color-muted-foreground)]">Waiting…</div>
          ) : (
            logs.map((l) => (
              <div
                key={l.id}
                className={cn(
                  'whitespace-pre-wrap px-3 py-0.5',
                  l.level === 'warn' && 'text-yellow-400',
                  l.level === 'error' && 'text-red-400'
                )}
              >
                {l.message}
              </div>
            ))
          )}
        </div>
      </div>

      {result ? (
        <div className="space-y-3 rounded-md border border-[var(--color-border)] p-4">
          <div className="flex items-center gap-2 text-sm font-medium text-green-400">
            ✓ Bootstrap complete
            {handoff === 'saving' ? (
              <span className="text-[var(--color-muted-foreground)]">· saving credentials…</span>
            ) : handoff === 'saved' ? (
              <span className="text-[var(--color-muted-foreground)]">· credentials saved</span>
            ) : handoff === 'failed' ? (
              <span className="text-red-400">· save failed</span>
            ) : null}
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-[var(--color-muted-foreground)]">State backend</dt>
            <dd className="font-mono">{result.stateBackendUrl}</dd>
            {result.apiServerUrl ? (
              <>
                <dt className="text-[var(--color-muted-foreground)]">API server</dt>
                <dd className="font-mono">{result.apiServerUrl}</dd>
              </>
            ) : null}
            {result.apiKey ? (
              <>
                <dt className="text-[var(--color-muted-foreground)]">API key</dt>
                <dd className="font-mono">{result.apiKey.id}</dd>
              </>
            ) : null}
            {result.statePromoted ? (
              <>
                <dt className="text-[var(--color-muted-foreground)]">State</dt>
                <dd>promoted to S3</dd>
              </>
            ) : null}
          </dl>
          {handoff === 'failed' && handoffError ? (
            <div className="rounded-md border border-red-500/50 bg-red-500/5 p-2 text-xs text-red-400">
              {handoffError} — connect manually via Settings.
            </div>
          ) : null}
          <Button onClick={() => navigate('/')} disabled={handoff === 'saving'}>
            {handoff === 'saving' ? 'Saving…' : 'Open dashboard'}
          </Button>
        </div>
      ) : null}

      {error ? (
        <div className="rounded-md border border-red-500/50 bg-red-500/5 p-4 text-sm">
          <div className="font-medium text-red-400">Bootstrap failed</div>
          <div className="mt-2 whitespace-pre-wrap font-mono text-xs">{error}</div>
          <div className="mt-3 flex gap-2">
            {failedPhase ? (
              <Button onClick={() => runFrom(failedPhase)} disabled={retrying}>
                {retrying ? 'Retrying…' : `Retry ${failedPhase}`}
              </Button>
            ) : null}
            <Button variant="outline" onClick={() => navigate('/bootstrap')} disabled={retrying}>
              Start over
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function deriveNameFromUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^api\./, '');
  } catch {
    return url;
  }
}

function PhaseCard({
  phase,
  label,
  state,
  canRetry,
  onRetry,
}: {
  phase: BootstrapPhase;
  label: string;
  state: PhaseState;
  canRetry: boolean;
  onRetry: () => void;
}) {
  const color =
    state === 'completed'
      ? 'text-green-400'
      : state === 'running'
        ? 'text-cyan-400'
        : state === 'failed'
          ? 'text-red-400'
          : state === 'skipped'
            ? 'text-[var(--color-muted-foreground)]'
            : 'text-[var(--color-muted-foreground)]';
  const glyph =
    state === 'completed'
      ? '✓'
      : state === 'running'
        ? '•'
        : state === 'failed'
          ? '✗'
          : state === 'skipped'
            ? '⚬'
            : '○';
  return (
    <div className="rounded-md border border-[var(--color-border)] p-3">
      <div className={cn('text-xs uppercase tracking-wide', color)}>
        {glyph} {phase}
      </div>
      <div className="mt-1 text-sm">{label}</div>
      <div className="mt-1 text-xs text-[var(--color-muted-foreground)]">{state}</div>
      {canRetry ? (
        <Button size="sm" variant="outline" className="mt-2 h-7 text-xs" onClick={onRetry}>
          Retry
        </Button>
      ) : null}
    </div>
  );
}
