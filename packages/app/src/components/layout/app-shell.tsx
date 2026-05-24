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
    ...(host.local?.runtimeStatus
      ? ([{ to: '/local-runtime', label: 'Local Runtime', icon: Server }] as NavItem[])
      : []),
    ...tailNav,
  ];

  return (
    <div className="grid h-full grid-cols-[220px_1fr] grid-rows-[auto_1fr_auto]">
      <aside className="row-span-3 border-r border-[var(--color-border)] bg-[var(--color-muted)]">
        <div className="px-4 py-4 text-sm font-semibold tracking-tight">Appliance</div>
        <nav className="flex flex-col gap-1 px-2">
          {nav.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-[var(--color-muted-foreground)] hover:bg-[var(--color-accent)] hover:text-[var(--color-accent-foreground)]',
                  isActive && 'bg-[var(--color-accent)] text-[var(--color-accent-foreground)]'
                )
              }
            >
              <item.icon className="h-4 w-4" />
              {item.label}
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

      <footer className="col-start-2 border-t border-[var(--color-border)] px-4 py-2 text-xs text-[var(--color-muted-foreground)]">
        {/* health / region / active deployments slot */}
      </footer>
    </div>
  );
}
