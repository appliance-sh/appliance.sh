import * as React from 'react';
import { NavLink, Outlet } from 'react-router';
import { Wand, Server, Boxes, Folder, Cog } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useSelectedCluster } from '@/hooks/use-selected-cluster';
import { TerminalLayer } from '@/pages/local-runtime/terminal-drawer';
import { ClusterSwitcher } from './cluster-switcher';
import { TerminalDock } from './terminal-dock';

type NavItem = {
  to: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  // Setup is highlighted while the shell is unconfigured (Q3); a ring
  // makes "start here" obvious without a second style of nav entry.
  prominent?: boolean;
};

export function AppShell() {
  // Adaptive Setup (docs/desktop-ia.md §8 Q3): ① is a prominent nav item
  // while unconfigured and is demoted out of the primary nav once a
  // cluster is selected (its recurring children — add-cluster, doctor —
  // surface from ② Clusters). "Unconfigured" = no selected cluster, the
  // same predicate the `/` landing resolver uses.
  const { cluster, isLoading } = useSelectedCluster();
  const configured = Boolean(cluster);

  // Five-area IA (§2). ④ Agents is deferred to I4 — it has no backing
  // page yet, so we don't add a dead nav item now; when it lands it is
  // `host.vm`-gated, mirroring today's Runtimes gate. Canonical labels
  // only: Setup / Clusters / Projects / Settings (no Dashboard/Overview/
  // Runtimes drift). Clusters stays always-visible — its desktop-only
  // bits are host-gated inside the page, not hidden from the rail.
  // Clusters uses `Boxes` (a distinct icon, not the brand mark's `Server`)
  // so the nav item doesn't read as a second logo (Devon).
  const nav: NavItem[] = [
    ...(!isLoading && !configured ? [{ to: '/setup', label: 'Setup', icon: Wand, prominent: true }] : []),
    { to: '/clusters', label: 'Clusters', icon: Boxes },
    { to: '/projects', label: 'Projects', icon: Folder },
    { to: '/settings', label: 'Settings', icon: Cog },
  ];

  return (
    // Below `sm` the sidebar collapses to an icon rail so narrow
    // windows (small desktop panes, phones) keep a usable content
    // column instead of a crushed two-column squeeze.
    // The third (auto) row holds the persistent terminal dock; it collapses
    // to zero height until a shell is open (TerminalDock renders null), so
    // the chrome is unchanged when no terminals exist.
    <div className="grid h-full grid-cols-[56px_1fr] grid-rows-[auto_1fr_auto] sm:grid-cols-[220px_1fr]">
      <aside className="row-span-3 flex flex-col border-r border-[var(--color-border)] bg-[var(--color-muted)]">
        {/* Brand — height + divider align with the content header so the
            top-left corner reads as one clean grid, not two strips. */}
        <div className="flex h-[57px] items-center gap-2.5 border-b border-[var(--color-border)] px-4">
          <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-[var(--color-foreground)] text-[var(--color-background)]">
            <Server className="h-3.5 w-3.5" />
          </div>
          <span className="hidden text-sm font-semibold tracking-tight sm:block">Appliance</span>
        </div>

        <nav className="flex flex-1 flex-col gap-0.5 px-2 py-3">
          {nav.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              title={item.label}
              // Hover only brightens the text; the filled background is
              // reserved for the active route so the two states never
              // read the same while the pointer rests on the sidebar.
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm font-medium',
                  item.prominent
                    ? 'text-[var(--color-foreground)] ring-1 ring-inset ring-[var(--color-border-strong)]'
                    : 'text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)]',
                  isActive && 'bg-[var(--color-accent)] text-[var(--color-foreground)]'
                )
              }
            >
              <item.icon className="h-4 w-4 shrink-0" />
              <span className="hidden sm:inline">{item.label}</span>
            </NavLink>
          ))}
        </nav>
      </aside>

      <header className="col-start-2 flex items-center justify-between border-b border-[var(--color-border)] px-4 py-3">
        <ClusterSwitcher />
        <div className="flex items-center gap-2">{/* search / notifications slot */}</div>
      </header>

      <main className="col-start-2 min-h-0 overflow-auto p-6">
        <Outlet />
      </main>

      {/* Terminal dock — a tab strip for ALL live shells, in the grid row
          below `<main>` and OUTSIDE the `<Outlet/>`. Reachable from every
          route, so a running-but-hidden shell is never orphaned. */}
      <TerminalDock />

      {/* Persistent terminal layer — OUTSIDE the `<Outlet/>` so navigating
          never unmounts the active shell. Its sessions live in
          `TerminalSessionsProvider`; this only shows/hides the view. */}
      <TerminalLayer />
    </div>
  );
}
