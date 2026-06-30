import type { RouteObject } from 'react-router';
import { Navigate } from 'react-router';
import { AppShell } from '@/components/layout/app-shell';
import { useSelectedCluster } from '@/hooks/use-selected-cluster';
import { DashboardPage } from '@/pages/dashboard';
import { ConnectPage } from '@/pages/connect';
import { ProjectDetailPage } from '@/pages/projects/detail';
import { EnvironmentsPage } from '@/pages/environments';
import { EnvironmentDetailPage } from '@/pages/environments/detail';
import { DeploymentsPage } from '@/pages/deployments/list';
import { DeploymentDetailPage } from '@/pages/deployments/detail';
import { SettingsPage } from '@/pages/settings';
import { LocalRuntimePage } from '@/pages/local-runtime';
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
  return <Navigate to={cluster ? '/projects' : '/setup'} replace />;
}

// Five-area IA route skeleton (I1). The shell + nav + routes are the new
// canonical structure; the SURFACES have not moved yet (I2–I5 do that), so
// each new path renders the existing page (or a thin redirect to it) and
// every old path stays reachable. Setup / Connect / Bootstrap live INSIDE
// `AppShell` so the terminal dock + cluster switcher persist during
// onboarding (§2).
export const routes: RouteObject[] = [
  {
    path: '/',
    element: <AppShell />,
    children: [
      { index: true, element: <LandingRedirect /> },

      // ① Setup — onboarding hub + its children. The hub is DashboardPage's
      // adaptive first-run branch (host-gated: microVM-express CTA on
      // desktop, Connect-led on web). Doctor's canonical home is here; for
      // I1 it renders the page that hosts the PreflightPanel (I5 extracts a
      // standalone Doctor). `/setup` stays routable even once configured.
      { path: 'setup', element: <DashboardPage /> },
      { path: 'setup/connect', element: <ConnectPage /> },
      { path: 'setup/bootstrap', element: <BootstrapWizardPage /> },
      { path: 'setup/bootstrap/run', element: <BootstrapProgressPage /> },
      { path: 'setup/doctor', element: <LocalRuntimePage /> },

      // ② Clusters — list + adaptive `/clusters/:id` detail (dispatch on
      // cluster kind lands in I2). For I1 both render the existing runtime
      // page; its desktop-only bits are host.vm-gated inside the page, so
      // this is safe on the web shell too.
      { path: 'clusters', element: <LocalRuntimePage /> },
      { path: 'clusters/:id', element: <LocalRuntimePage /> },

      // ③ Projects — the Overview grid home, deploy wizard, project detail,
      // and Environments/Deployments folded UNDER the area as nested routes
      // (they have no top-level nav entry; see the old-route block for the
      // still-live flat paths their existing links use).
      { path: 'projects', element: <DashboardPage /> },
      { path: 'projects/deploy', element: <LocalRuntimeDeployPage /> },
      { path: 'projects/:id', element: <ProjectDetailPage /> },
      { path: 'projects/:projectId/environments/:id', element: <EnvironmentDetailPage /> },

      // ④ Agents — deferred to I4 (no backing page yet). The launcher lives
      // on the runtime page today, so the stub redirects there.
      { path: 'agents', element: <Navigate to="/clusters" replace /> },

      // ⑤ Settings
      { path: 'settings', element: <SettingsPage /> },

      // ---- old routes, kept reachable so nothing breaks (I2–I5 retire) ----
      // Stateless → redirect to the new canonical path.
      { path: 'dashboard', element: <Navigate to="/projects" replace /> },
      { path: 'connect', element: <Navigate to="/setup/connect" replace /> },
      // These carry `?mode=` / router state, so we ALIAS (render the same
      // element at both paths) instead of redirecting — a redirect would
      // drop the query / `location.state` the wizard + progress pages read.
      { path: 'bootstrap', element: <BootstrapWizardPage /> },
      { path: 'bootstrap/run', element: <BootstrapProgressPage /> },
      { path: 'local-runtime', element: <LocalRuntimePage /> },
      { path: 'local-runtime/deploy', element: <LocalRuntimeDeployPage /> },
      // Environments/Deployments lose their nav entries but keep their flat
      // routes so existing in-app links resolve (§2 / §8 Q2).
      { path: 'environments', element: <EnvironmentsPage /> },
      { path: 'environments/:projectId/:id', element: <EnvironmentDetailPage /> },
      { path: 'deployments', element: <DeploymentsPage /> },
      { path: 'deployments/:id', element: <DeploymentDetailPage /> },
    ],
  },
];
