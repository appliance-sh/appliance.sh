import * as React from 'react';
import type { ConsoleHost } from '@/lib/host';

const HostContext = React.createContext<ConsoleHost | null>(null);

export function HostProvider({ host, children }: { host: ConsoleHost; children: React.ReactNode }) {
  return <HostContext.Provider value={host}>{children}</HostContext.Provider>;
}

export function useHost(): ConsoleHost {
  const host = React.useContext(HostContext);
  if (!host) {
    throw new Error('useHost called outside HostProvider');
  }
  return host;
}
