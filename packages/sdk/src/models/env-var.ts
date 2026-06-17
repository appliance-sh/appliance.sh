import { z } from 'zod';

// Per-environment stored variables ("environment secrets"). These live
// server-side on the environment and are injected into every deploy of
// that environment, so a value set once persists across machines, the
// desktop, and CI — unlike `--env-file`, which only applies to the
// single deploy that passed it.
//
// POSIX-ish key validation: a name a shell can export. Keeps us from
// storing keys the runtime would silently drop.
export const envVarKey = z
  .string()
  .min(1)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'env var names must match [A-Za-z_][A-Za-z0-9_]*');

export const envVarsInput = z.object({
  // The full set of variables to store for the environment. A `set`
  // merges these over the existing set; an `unset` is modelled as a
  // separate route so an empty map here is unambiguous.
  variables: z.record(envVarKey, z.string()),
});

export type EnvVarsInput = z.infer<typeof envVarsInput>;

// Listing never returns secret values — only the key names, so the CLI
// can show what's set without printing secrets to a terminal. Callers
// that need a value must read it from their own source of truth.
export const envVarsList = z.object({
  keys: z.array(z.string()),
});

export type EnvVarsList = z.infer<typeof envVarsList>;
