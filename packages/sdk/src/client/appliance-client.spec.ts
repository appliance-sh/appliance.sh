import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApplianceClient } from './appliance-client';
import { VERSION } from '../version';

// The `x-appliance-client` tag must be context-sensitive: server-side
// callers (CLI, engine, tests — no `document` global) always send it,
// browser/webview callers NEVER do. Old deployed api-servers don't
// allow the header in their CORS preflight allow-list, so a browser
// client attaching it would lose every cross-origin request to a
// network-shaped TypeError — no 401, no heal, no banner.

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function stubFetch() {
  const fetchMock = vi.fn(async () => jsonResponse({ ok: true }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function sentHeaders(fetchMock: ReturnType<typeof vi.fn>): Record<string, string> {
  const init = fetchMock.mock.calls[0]![1] as RequestInit;
  return (init.headers ?? {}) as Record<string, string>;
}

describe('x-appliance-client tagging', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends <product>/<version> from non-browser contexts', async () => {
    const fetchMock = stubFetch();
    const client = createApplianceClient({ baseUrl: 'http://api.test', product: 'cli' });

    await client.healthz();

    expect(sentHeaders(fetchMock)['x-appliance-client']).toBe(`cli/${VERSION}`);
  });

  it('defaults the product tag to sdk', async () => {
    const fetchMock = stubFetch();
    const client = createApplianceClient({ baseUrl: 'http://api.test' });

    await client.getBootstrapStatus();

    expect(sentHeaders(fetchMock)['x-appliance-client']).toBe(`sdk/${VERSION}`);
  });

  it('never sends the tag when a document global exists (browser/webview)', async () => {
    // Simulate a browser context: the constructor keys off `document`.
    vi.stubGlobal('document', {});
    const fetchMock = stubFetch();
    const client = createApplianceClient({ baseUrl: 'http://api.test', product: 'app' });

    await client.healthz();
    await client.getBootstrapStatus();

    for (const call of fetchMock.mock.calls) {
      const headers = ((call as unknown[])[1] as RequestInit).headers as Record<string, string>;
      expect(headers?.['x-appliance-client']).toBeUndefined();
    }
  });

  it('tags signed data-plane requests in non-browser contexts too', async () => {
    const fetchMock = stubFetch();
    const client = createApplianceClient({
      baseUrl: 'http://api.test',
      product: 'cli',
      credentials: { keyId: 'k1', secret: 'c2VjcmV0LXNlY3JldC1zZWNyZXQ=' },
    });

    await client.listProjects();

    const headers = sentHeaders(fetchMock);
    expect(headers['x-appliance-client']).toBe(`cli/${VERSION}`);
    // Signing still happened alongside the (unsigned) tag header.
    expect(headers['signature']).toBeDefined();
  });
});
