import { Buffer as BufferPolyfill } from 'buffer';

// http-message-signatures (the RFC 9421 lib the SDK's signing module
// wraps) calls `Buffer.from(...)` directly at several sites. Node
// provides Buffer as a global; browser runtimes do not. Install the
// `buffer` polyfill on globalThis before any code that might reach
// the signing chain runs.
//
// This file is imported at the top of the app entry (`index.ts`) so
// the polyfill lands before React even mounts. The native Buffer
// takes precedence — we only install when it's missing.
if (typeof (globalThis as { Buffer?: unknown }).Buffer === 'undefined') {
  (globalThis as unknown as { Buffer: typeof BufferPolyfill }).Buffer = BufferPolyfill;
}
