import type * as React from 'react';
import type { RouteObject } from 'react-router';
import { Navigate, useLocation } from 'react-router';
import { AppShell } from '@/components/layout/app-shell';
import { useSelectedCluster } from '@/hooks/use-selected-cluster';
import { useKeyRole } from '@/hooks/use-key-role';
import { isBootstrapOnlyConsole } from '@/lib/runtime-config';
import { DashboardPage } from '@/pages/dashboard';
import { InvitePage, BootstrapHandoffPage } from '@/pages/invite';
import { ConnectPage } from '@/pages/connect';
import { ProjectDetailPage } from '@/pages/projects/detail';
import { EnvironmentsPage } from '@/pages/environments';
import { EnvironmentDetailPage } from '@/pages/environments/detail';
import { DeploymentsPage } from '@/pages/deployments/list';
import { DeploymentDetailPage } from '@/pages/deployments/detail';
import { SettingsPage } from '@/pages/settings';
import { SetupDoctorPage } from '@/pages/setup/doctor';
import { AgentsPage } from '@/pages/agents';
import { ClustersPage } from '@/pages/clusters';
import { ClusterDetailPage } from '@/pages/clusters/detail';
import { LocalRuntimeDeployPage } from '@/pages/local-runtime/deploy';
import { BootstrapWizardPage } from '@/pages/bootstrap/wizard';
import { BootstrapProgressPage } from '@/pages/bootstrap/progress';

// Default-landing resolver (docs/desktop-ia.md §2 + §8 Q3): Setup when the
// shell is unconfigured (no selected cluster), else the Projects home.
// Replaces DashboardPage's own first-run branch at the index route. We
// hold (render nothing) until the host config resolves so we never flash
// the wrong destination.
function LandingRedirect() {
  const { cluster, isLoading } = useSelectedCluster();
  if (isLoading) return null;
  // A bootstrap-only console (high-security deployments) never shows
  // the app: once connected, hand off to the hardened console.
  if (isBootstrapOnlyConsole()) {
    return <Navigate to={cluster ? '/setup-complete' : '/setup'} replace />;
  }
  return <Navigate to={cluster ? '/projects' : '/setup'} replace />;
}

// Operator-only surfaces (clusters, bootstrap, doctor, agents) are
// hidden from member keys — the invite-minted role for teammates. The
// api-server enforces the real boundary (403s on admin routes); this
// guard just keeps members from landing on screens made of dead ends.
function RequireAdmin({ children }: { children: React.ReactNode }) {
  const { role, isLoading } = useKeyRole();
  if (isLoading) return null;
  if (role !== 'admin') return <Navigate to="/" replace />;
  return <>{children}</>;
}

// The deploy wizard's canonical home is ③ `/projects/deploy` (I3); the old
// `/local-runtime/deploy` is an alias that redirects. It carries the deploy
// intent in the query string (`?project=&environment=`), so we redirect
// PRESERVING `location.search` — a bare `<Navigate>` would drop it and
// dead-end the "Set up first deploy" links.
function DeployAliasRedirect() {
  const { search } = useLocation();
  return <Navigate to={`/projects/deploy${search}`} replace />;
}

// Five-area IA route skeleton (I1). The shell + nav + routes are the new
// canonical structure; the SURFACES have not moved yet (I2–I5 do that), so
// each new path renders the existing page (or a thin redirect to it) and
// every old path stays reachable. Setup / Connect / Bootstrap live INSIDE
// `AppShell` so the terminal dock + cluster switcher persist during
// onboarding (§2).
export const routes: RouteObject[] = [
  // Standalone (no AppShell chrome): the invite landing a teammate's
  // link opens, and the "setup only" handoff a bootstrap-scoped console
  // shows once connected. Both are first-run screens — nav, cluster
  // switcher and the terminal dock would only add noise.
  { path: '/invite', element: <InvitePage /> },
  { path: '/setup-complete', element: <BootstrapHandoffPage /> },
  {
    path: '/',
    element: <AppShell />,
    children: [
      { index: true, element: <LandingRedirect /> },

      // ① Setup — onboarding hub + its children. The hub is DashboardPage's
      // adaptive first-run branch (host-gated: microVM-express CTA on
      // desktop, Connect-led on web). Doctor is its own standalone page
      // (I5 extracted it out of the deleted kitchen-sink runtimes page).
      // `/setup` stays routable even once configured.
      { path: 'setup', element: <DashboardPage /> },
      { path: 'setup/connect', element: <ConnectPage /> },
      {
        path: 'setup/bootstrap',
        element: (
          <RequireAdmin>
            <BootstrapWizardPage />
          </RequireAdmin>
        ),
      },
      {
        path: 'setup/bootstrap/run',
        element: (
          <RequireAdmin>
            <BootstrapProgressPage />
          </RequireAdmin>
        ),
      },
      {
        path: 'setup/doctor',
        element: (
          <RequireAdmin>
            <SetupDoctorPage />
          </RequireAdmin>
        ),
      },

      // ② Clusters — the live owner of cluster/runtime management (I2). The
      // list (cloud clusters + local runtimes) and the single ADAPTIVE
      // `/clusters/:id` detail that dispatches on cluster kind: cloud →
      // lifecycle ops; local runtime → tabbed VM management (lifecycle /
      // egress / credentials / facts). Desktop-only bits are host.vm-gated
      // inside the pages, so this is safe on the web shell too.
      {
        path: 'clusters',
        element: (
          <RequireAdmin>
            <ClustersPage />
          </RequireAdmin>
        ),
      },
      {
        path: 'clusters/:id',
        element: (
          <RequireAdmin>
            <ClusterDetailPage />
          </RequireAdmin>
        ),
      },

      // ③ Projects — the Overview grid home, deploy wizard, project detail,
      // and Environments/Deployments folded UNDER the area as nested routes
      // (they have no top-level nav entry; see the old-route block for the
      // still-live flat paths their existing links use).
      { path: 'projects', element: <DashboardPage /> },
      { path: 'projects/deploy', element: <LocalRuntimeDeployPage /> },
      { path: 'projects/:id', element: <ProjectDetailPage /> },
      { path: 'projects/:projectId/environments/:id', element: <EnvironmentDetailPage /> },

      // ④ Agents — the first-class area (I4): per-agent sign-in (moved from
      // ⑤ Settings) + the launcher (moved from ② cluster detail) + a runs list
      // across runtimes. Desktop-only (`host.vm`); the nav item is hidden on
      // web and the page renders a "desktop app only" message there. Observe
      // terminals stay in the global dock.
      {
        path: 'agents',
        element: (
          <RequireAdmin>
            <AgentsPage />
          </RequireAdmin>
        ),
      },

      // ⑤ Settings
      { path: 'settings', element: <SettingsPage /> },

      // ---- old routes, kept reachable so nothing breaks (I2–I5 retire) ----
      // Stateless → redirect to the new canonical path.
      { path: 'dashboard', element: <Navigate to="/projects" replace /> },
      { path: 'connect', element: <Navigate to="/setup/connect" replace /> },
      // These carry `?mode=` / router state, so we ALIAS (render the same
      // element at both paths) instead of redirecting — a redirect would
      // drop the query / `location.state` the wizard + progress pages read.
      {
        path: 'bootstrap',
        element: (
          <RequireAdmin>
            <BootstrapWizardPage />
          </RequireAdmin>
        ),
      },
      {
        path: 'bootstrap/run',
        element: (
          <RequireAdmin>
            <BootstrapProgressPage />
          </RequireAdmin>
        ),
      },
      // ② now owns runtime management — the old runtimes page redirects to
      // the cluster list (I2). The doctor preflight it used to host now
      // stands alone at /setup/doctor (its own `SetupDoctorPage`; the old
      // kitchen-sink page was deleted in I5).
      { path: 'local-runtime', element: <Navigate to="/clusters" replace /> },
      // Deploy wizard moved to ③ /projects/deploy (I3); alias preserves the
      // `?project=&environment=` intent on the redirect.
      { path: 'local-runtime/deploy', element: <DeployAliasRedirect /> },
      // Environments/Deployments lose their nav entries but keep their flat
      // routes so existing in-app links resolve (§2 / §8 Q2).
      { path: 'environments', element: <EnvironmentsPage /> },
      { path: 'environments/:projectId/:id', element: <EnvironmentDetailPage /> },
      { path: 'deployments', element: <DeploymentsPage /> },
      { path: 'deployments/:id', element: <DeploymentDetailPage /> },
    ],
  },
];
