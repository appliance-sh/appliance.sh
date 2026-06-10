import * as React from 'react';

/** Shared empty-state card: dashed border, centered message, optional
 *  CTA. Keeps the copy pattern consistent across list pages — a short
 *  "what's missing" line plus, when possible, how to get the first one. */
export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="rounded-md border border-dashed border-[var(--color-border)] p-8 text-center">
      <div className="text-sm font-medium">{title}</div>
      {description ? <div className="mt-1 text-sm text-[var(--color-muted-foreground)]">{description}</div> : null}
      {action ? <div className="mt-4 flex justify-center">{action}</div> : null}
    </div>
  );
}
