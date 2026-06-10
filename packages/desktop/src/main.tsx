import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Console } from '@appliance.sh/app';
import type { ConsoleHost } from '@appliance.sh/app';
import '@appliance.sh/app/styles.css';
import { tauriHost } from './host';

const container = document.getElementById('root');
if (!container) throw new Error('#root element not found');

// Dev-only browser harness: `pnpm --filter @appliance.sh/desktop dev`,
// then open http://localhost:1420/?mock-host[&scenario=…] in a plain
// browser to work on desktop-only pages (Local Runtime, deploy wizard,
// bootstrap) without a Tauri build. The dynamic import keeps the mock
// out of production bundles entirely.
async function resolveHost(): Promise<ConsoleHost> {
  if (import.meta.env.DEV) {
    const { mockHostEnabled, createMockHost } = await import('./mock-host');
    if (mockHostEnabled()) return createMockHost();
  }
  return tauriHost;
}

resolveHost().then((host) => {
  createRoot(container).render(
    <StrictMode>
      <Console host={host} />
    </StrictMode>
  );
});
