import { QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createBrowserRouter } from 'react-router';
import { HostProvider } from '@/providers/host-provider';
import { TerminalSessionsProvider } from '@/providers/terminal-sessions-provider';
import { ToastProvider } from '@/components/ui/toast';
import { ConfirmProvider } from '@/components/ui/confirm-dialog';
import { isAuthShapedError } from '@/components/friendly-error';
import { reportAuthFailure } from '@/lib/auth-signal';
import { routes } from '@/router/routes';
import type { ConsoleHost } from '@/lib/host';
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import '@/styles.css';

const queryClient = new QueryClient({
  // Any query failing with an auth-shaped error (401/403, bad signature,
  // expired key) raises the global auth-expiry signal — the AppShell shows
  // a single dismissible "connection expired" banner with a Reconnect CTA.
  queryCache: new QueryCache({
    onError: (error) => {
      if (isAuthShapedError(error)) reportAuthFailure();
    },
  }),
  defaultOptions: {
    queries: { staleTime: 5_000, refetchOnWindowFocus: false },
  },
});

const router = createBrowserRouter(routes);

export interface ConsoleProps {
  host: ConsoleHost;
}

export function Console({ host }: ConsoleProps) {
  return (
    <HostProvider host={host}>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <ConfirmProvider>
            {/* Above the router so terminal sessions outlive navigation
                (the route `<Outlet/>` swaps, the sessions don't). */}
            <TerminalSessionsProvider>
              <RouterProvider router={router} />
            </TerminalSessionsProvider>
          </ConfirmProvider>
        </ToastProvider>
      </QueryClientProvider>
    </HostProvider>
  );
}
