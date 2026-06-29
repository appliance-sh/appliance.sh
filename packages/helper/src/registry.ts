import { craneProvider } from './providers/crane.js';
import { dockerProvider } from './providers/docker.js';
import { kubectlProvider } from './providers/kubectl.js';
import type { Provider } from './types.js';

// Order matters for UI rendering: docker first (the engine), then the
// tools that run on top of it (kubectl, crane). New providers append
// here; consumers iterate `defaultProviders` rather than referencing
// individual exports so additions Just Work.
export const defaultProviders: Provider[] = [dockerProvider, kubectlProvider, craneProvider];

export function findProvider(name: string): Provider | undefined {
  return defaultProviders.find((p) => p.name === name);
}
