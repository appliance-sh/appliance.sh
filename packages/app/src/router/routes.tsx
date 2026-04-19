import type { RouteObject } from 'react-router';
import { AppShell } from '@/components/layout/app-shell';
import { DashboardPage } from '@/pages/dashboard';
import { ConnectPage } from '@/pages/connect';
import { ProjectsPage } from '@/pages/projects';
import { ProjectDetailPage } from '@/pages/projects/detail';
import { EnvironmentsPage } from '@/pages/environments';
import { EnvironmentDetailPage } from '@/pages/environments/detail';
import { DeploymentsPage } from '@/pages/deployments/list';
import { DeploymentDetailPage } from '@/pages/deployments/detail';
import { SettingsPage } from '@/pages/settings';
import { BootstrapWizardPage } from '@/pages/bootstrap/wizard';
import { BootstrapProgressPage } from '@/pages/bootstrap/progress';

export const routes: RouteObject[] = [
  { path: '/connect', element: <ConnectPage /> },
  { path: '/bootstrap', element: <BootstrapWizardPage /> },
  { path: '/bootstrap/run', element: <BootstrapProgressPage /> },
  {
    path: '/',
    element: <AppShell />,
    children: [
      { index: true, element: <DashboardPage /> },
      { path: 'projects', element: <ProjectsPage /> },
      { path: 'projects/:id', element: <ProjectDetailPage /> },
      { path: 'environments', element: <EnvironmentsPage /> },
      { path: 'environments/:projectId/:id', element: <EnvironmentDetailPage /> },
      { path: 'deployments', element: <DeploymentsPage /> },
      { path: 'deployments/:id', element: <DeploymentDetailPage /> },
      { path: 'settings', element: <SettingsPage /> },
    ],
  },
];
