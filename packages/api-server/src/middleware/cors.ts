import cors, { type CorsOptions } from 'cors';

// Browser origins that may talk to this api-server:
//   - the hosted web console at console.appliance.sh
//   - any localhost port (dev shells on the user's machine)
//   - Tauri-served origins (desktop shell). Platforms use different
//     schemes: macOS/Linux use `tauri://localhost`, Windows uses
//     `https://tauri.localhost`, `http://tauri.localhost` also seen.
//
// Allow-list can be extended at runtime via APPLIANCE_CORS_ORIGINS
// (comma-separated exact origins), useful for custom-deployed
// consoles without a code change.
const EXACT_ORIGINS = new Set<string>(['https://console.appliance.sh']);

const PATTERNS: readonly RegExp[] = [
  /^https?:\/\/localhost(:\d+)?$/,
  /^https?:\/\/127\.0\.0\.1(:\d+)?$/,
  /^https?:\/\/\[::1\](:\d+)?$/,
  /^tauri:\/\/.+$/,
  /^https?:\/\/tauri\.localhost$/,
];

function extraOrigins(): string[] {
  const raw = process.env.APPLIANCE_CORS_ORIGINS;
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function isAllowed(origin: string): boolean {
  if (EXACT_ORIGINS.has(origin)) return true;
  if (extraOrigins().includes(origin)) return true;
  return PATTERNS.some((p) => p.test(origin));
}

const options: CorsOptions = {
  origin: (origin, callback) => {
    // Non-browser callers (curl, server-side fetch) don't send Origin.
    // Let them through — auth is enforced separately.
    if (!origin) return callback(null, true);
    if (isAllowed(origin)) return callback(null, true);
    callback(new Error(`origin ${origin} not allowed by CORS`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Content-Digest', 'Signature', 'Signature-Input', 'X-Bootstrap-Token'],
  exposedHeaders: ['Content-Digest', 'Signature', 'Signature-Input'],
  maxAge: 600,
};

export const corsMiddleware = cors(options);
