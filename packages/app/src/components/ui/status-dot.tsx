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
  return <span className={cn('inline-block rounded-full', dim, color, className)} title={status} aria-label={status} />;
}
