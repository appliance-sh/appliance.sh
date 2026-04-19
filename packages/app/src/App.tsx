import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createBrowserRouter } from 'react-router';
import { HostProvider } from '@/providers/host-provider';
import { routes } from '@/router/routes';
import type { ConsoleHost } from '@/lib/host';
import '@/styles.css';

const queryClient = new QueryClient({
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
        <RouterProvider router={router} />
      </QueryClientProvider>
    </HostProvider>
  );
}
