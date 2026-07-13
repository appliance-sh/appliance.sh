import { QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createBrowserRouter } from 'react-router';
import { HostProvider } from '@/providers/host-provider';
import { TerminalSessionsProvider } from '@/providers/terminal-sessions-provider';
import { ToastProvider } from '@/components/ui/toast';
import { ConfirmProvider } from '@/components/ui/confirm-dialog';
import { isAuthShapedError } from '@/components/friendly-error';
import { handleAuthShapedError, registerAuthHeal } from '@/lib/microvm-heal';
import { routes } from '@/router/routes';
import type { ConsoleHost } from '@/lib/host';
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import '@/styles.css';

const queryClient = new QueryClient({
  // Any query failing with an auth-shaped error (401/403, bad signature,
  // expired key) first attempts a microVM credential self-heal (re-mint
  // via the VM's bootstrap token) and only raises the global auth-expiry
  // signal — the AppShell's dismissible "connection expired" banner with
  // a Reconnect CTA — when healing isn't possible or didn't work.
  queryCache: new QueryCache({
    onError: (error) => {
      if (isAuthShapedError(error)) handleAuthShapedError();
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
  // The query cache's error handler runs outside React — hand it the
  // host + client it needs to attempt a credential self-heal.
  registerAuthHeal(host, queryClient);
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
