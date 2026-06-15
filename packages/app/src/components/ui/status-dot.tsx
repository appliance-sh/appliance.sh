import { cn } from '@/lib/utils';

// Maps deployment / environment status strings to a colored dot.
// Unknown statuses fall through to muted.
const STATUS_COLORS: Record<string, string> = {
  // Deployment statuses
  pending: 'bg-yellow-500',
  in_progress: 'bg-cyan-500',
  succeeded: 'bg-green-500',
  failed: 'bg-red-500',
  // Environment statuses
  deploying: 'bg-cyan-500',
  deployed: 'bg-green-500',
  destroying: 'bg-amber-500',
  destroyed: 'bg-[var(--color-muted-foreground)]',
};

// Transient states pulse so an in-flight deploy reads as "alive" at a
// glance; terminal states (succeeded/failed/deployed) sit still.
const ACTIVE_STATUSES = new Set(['pending', 'in_progress', 'deploying', 'destroying']);

export function StatusDot({
  status,
  size = 'sm',
  className,
}: {
  status: string;
  size?: 'sm' | 'md';
  className?: string;
}) {
  const color = STATUS_COLORS[status] ?? 'bg-[var(--color-muted-foreground)]';
  const dim = size === 'md' ? 'h-2.5 w-2.5' : 'h-2 w-2';
  return (
    <span className={cn('relative inline-flex', dim, className)} title={status} aria-label={status}>
      {ACTIVE_STATUSES.has(status) ? (
        <span className={cn('absolute inline-flex h-full w-full animate-ping rounded-full opacity-60', color)} />
      ) : null}
      <span className={cn('relative inline-block h-full w-full rounded-full', color)} />
    </span>
  );
}
