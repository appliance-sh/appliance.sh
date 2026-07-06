import * as dns from 'node:dns';
import { Agent, setGlobalDispatcher, fetch as undiciFetch } from 'undici';

// Make `*.localhost` URLs work in Node on Windows.
//
// RFC 6761 reserves `.localhost` for loopback, and the local runtimes
// lean on it: the microVM api-server lives at `api.appliance.localhost`
// and every deploy gets a `<stack>.appliance.localhost` Ingress route.
// Browsers and curl resolve those names themselves, and the macOS and
// systemd-resolved Linux resolvers implement the RFC — but Windows'
// resolver only special-cases the bare `localhost`, so every Node fetch
// against a `.localhost` subdomain dies with ENOTFOUND.
//
// A Host-header override can't fix it (undici strips `host` from fetch
// init), so instead route the process' fetch through an undici Agent
// whose connect-time `lookup` answers loopback for `.localhost` names
// and defers to `dns.lookup` for everything else. The URL — and with it
// the HTTP authority the server routes and verifies signatures on —
// keeps the original hostname; only the socket target changes.

/** dns.lookup-compatible resolver that answers loopback for RFC 6761
 *  `.localhost` names without consulting the OS resolver. */
const localhostLookup = function lookup(
  hostname: string,
  options: dns.LookupOptions | ((...args: unknown[]) => void),
  callback?: (...args: unknown[]) => void
) {
  const opts: dns.LookupOptions = typeof options === 'function' ? {} : options;
  const cb = (typeof options === 'function' ? options : callback) as (...args: unknown[]) => void;
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    const family = opts.family === 6 ? 6 : 4;
    const address = family === 6 ? '::1' : '127.0.0.1';
    if (opts.all) {
      process.nextTick(cb, null, [{ address, family }]);
    } else {
      process.nextTick(cb, null, address, family);
    }
    return;
  }
  dns.lookup(
    hostname,
    opts,
    cb as (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family: number) => void
  );
} as typeof dns.lookup;

/**
 * Install a `.localhost`-aware global fetch. Idempotent. No-op outside
 * Windows (other supported resolvers implement RFC 6761) and outside
 * Node (the bun-compiled binary ships Bun's own fetch — if Bun's
 * resolver proves to have the same gap, that needs a Bun-side fix).
 */
export function ensureLocalhostFetch(): void {
  if (process.platform !== 'win32') return;
  if (!process.versions?.node || process.versions?.bun) return;
  const marked = globalThis as { __applianceLocalhostFetch?: boolean };
  if (marked.__applianceLocalhostFetch) return;
  setGlobalDispatcher(new Agent({ connect: { lookup: localhostLookup } }));
  // Node's built-in fetch uses its internal undici copy, which ignores
  // the npm copy's global dispatcher — swap in the npm copy's fetch so
  // the Agent above actually serves it.
  globalThis.fetch = undiciFetch as unknown as typeof globalThis.fetch;
  marked.__applianceLocalhostFetch = true;
}
