import { z } from 'zod';
import { dnsName } from '../common';
import { envVarKey } from './env-var';

// A stack is a client-side collection manifest (`appliance.stack.json`):
// one file naming a set of appliance directories so they can be deployed,
// inspected, and destroyed as a unit (`appliance stack …`). It never
// crosses the API — each member still becomes an ordinary Project +
// Environment on whichever api-server the active profile points at,
// which is exactly what makes a stack portable between the local
// microVM runtime and a cloud installation. The schema lives here so
// the CLI and desktop share one contract.

export const stackAppInput = z.object({
  // Directory of the member appliance, relative to the stack file.
  dir: z.string().min(1),
  // Project name override. Defaults to the member manifest's `name`.
  project: dnsName.optional(),
  // Per-app environment pin. An explicit environment passed to
  // `appliance stack deploy <env>` still wins, so a stack can be
  // cloned wholesale into a fresh environment name.
  environment: dnsName.optional(),
  // Deploy-time env vars for this member, resolved by `stack deploy`.
  // Values may reference sibling members by their `dir`:
  //   {{service:api}} → http://<project>-<environment>:<port> — the
  //     in-network address (docker network alias / k8s Service DNS),
  //     for service-to-service calls; deterministic, so it works
  //     regardless of deploy order.
  //   {{url:api}}     → the sibling's host-facing URL from its deploy
  //     this run; the member must appear earlier in `apps`.
  // Interpolation keeps stacks clonable: `stack deploy demo2` rewires
  // every reference to the fresh environment with no file edits.
  env: z.record(envVarKey, z.string()).optional(),
});

export const stackInput = z.object({
  manifest: z.literal('v1'),
  type: z.literal('stack'),
  name: dnsName,
  // Default environment for every member. Precedence per app:
  // CLI argument > app.environment > this field > 'dev'.
  environment: dnsName.optional(),
  apps: z.array(stackAppInput).min(1),
});

export type StackAppInput = z.infer<typeof stackAppInput>;
export type StackInput = z.infer<typeof stackInput>;
