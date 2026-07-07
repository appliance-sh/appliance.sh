import { kubectlProvider } from './providers/kubectl.js';
import type { Provider } from './types.js';

// kubectl is the sole managed binary the appliance flow still needs
// (the Rust egress publisher and debug tooling drive it). Docker,
// crane, and buildctl are gone with the host-side build/delivery
// paths: the api-server runs as a guest binary inside the microVM and
// images build server-side with the in-VM BuildKit. New providers
// append here; consumers iterate `defaultProviders` rather than
// referencing individual exports so additions Just Work.
export const defaultProviders: Provider[] = [kubectlProvider];

export function findProvider(name: string): Provider | undefined {
  return defaultProviders.find((p) => p.name === name);
}
