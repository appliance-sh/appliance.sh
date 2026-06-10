import { cn } from '@/lib/utils';

/** Loading placeholder block. Compose into card/row-shaped layouts so
 *  loading states keep the destination's geometry instead of swapping
 *  a "Loading…" string in. */
export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded-md bg-[var(--color-muted)]', className)} />;
}
