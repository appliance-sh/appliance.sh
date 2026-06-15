import * as React from 'react';
import { NavLink, Outlet } from 'react-router';
import { LayoutDashboard, Folder, Box, Rocket, Settings, Server } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useHost } from '@/providers/host-provider';
import { ClusterSwitcher } from './cluster-switcher';

type NavItem = {
  to: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  end?: boolean;
};

const baseNav: NavItem[] = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/projects', label: 'Projects', icon: Folder },
  { to: '/environments', label: 'Environments', icon: Box },
  { to: '/deployments', label: 'Deployments', icon: Rocket },
];

const tailNav: NavItem[] = [{ to: '/settings', label: 'Settings', icon: Settings }];

export function AppShell() {
  const host = useHost();
  // Surface Local Runtime only when the host can actually drive it
  // (desktop). The web shell omits `local`, so the link would 404 on
  // first click — better to hide it than disable it.
  const nav: NavItem[] = [
    ...baseNav,
    ...(host.local?.runtimeStatus ? ([{ to: '/local-runtime', label: 'Runtimes', icon: Server }] as NavItem[]) : []),
    ...tailNav,
  ];

  return (
    // Below `sm` the sidebar collapses to an icon rail so narrow
    // windows (small desktop panes, phones) keep a usable content
    // column instead of a crushed two-column squeeze.
    <div className="grid h-full grid-cols-[56px_1fr] grid-rows-[auto_1fr] sm:grid-cols-[220px_1fr]">
      <aside className="row-span-2 flex flex-col border-r border-[var(--color-border)] bg-[var(--color-muted)]">
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
              end={item.end}
              title={item.label}
              // Hover only brightens the text; the filled background is
              // reserved for the active route so the two states never
              // read the same while the pointer rests on the sidebar.
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm font-medium text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)]',
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

      <main className="col-start-2 overflow-auto p-6">
        <Outlet />
      </main>
    </div>
  );
}
