import { describe, expect, it } from 'vitest';
import { IN_CLUSTER_API_SERVER_HOSTNAME, apiServerUrlForHostPort } from './api-server.js';

describe('apiServerUrlForHostPort', () => {
  it('carries the host port so deploy-result URLs are clickable from the host', () => {
    expect(apiServerUrlForHostPort(8081)).toBe(`http://${IN_CLUSTER_API_SERVER_HOSTNAME}:8081`);
  });

  it('omits the default HTTP port', () => {
    expect(apiServerUrlForHostPort(80)).toBe(`http://${IN_CLUSTER_API_SERVER_HOSTNAME}`);
  });

  it('stays on the hostname every saved profile already uses', () => {
    // The guest api-server's ingress route (guest.rs APISERVER_COMMON)
    // and every persisted profile URL both hang off this exact
    // hostname — changing it breaks existing credentials.
    expect(IN_CLUSTER_API_SERVER_HOSTNAME).toBe('api.appliance.localhost');
  });
});
