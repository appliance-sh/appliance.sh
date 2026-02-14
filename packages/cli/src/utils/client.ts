import { createApplianceClient } from '@appliance.sh/sdk';
import { loadCredentials } from './credentials.js';

export function getClient() {
  const credentials = loadCredentials();
  if (!credentials) {
    throw new Error('Not logged in. Run `appliance login` first.');
  }

  return createApplianceClient({
    baseUrl: credentials.apiUrl,
    credentials: {
      keyId: credentials.keyId,
      secret: credentials.secret,
    },
  });
}
