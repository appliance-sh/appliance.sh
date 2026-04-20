import * as os from 'node:os';
import type { BootstrapEvent } from '../types';

/**
 * LocalWorkspace spawns the `pulumi` CLI, which needs HOME/PATH set
 * so it can find plugins and creds. Node spawn inherits env by
 * default but being explicit avoids platform quirks (notably
 * GitHub Actions runners with pruned env).
 */
export function homeEnv(): Record<string, string> {
  return {
    HOME: process.env.HOME ?? os.homedir(),
    PATH: process.env.PATH ?? '',
  };
}

/**
 * Standard AWS credential-chain env vars. We don't mint credentials;
 * we pass whatever the caller already has to the subprocess.
 */
export function awsCredsFromEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of [
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_SESSION_TOKEN',
    'AWS_PROFILE',
    'AWS_DEFAULT_REGION',
    'AWS_SHARED_CREDENTIALS_FILE',
    'AWS_CONFIG_FILE',
  ]) {
    const v = process.env[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/**
 * Map Pulumi's engine events to the public BootstrapEvent discriminated
 * union. Only the resource-lifecycle and diagnostic event shapes we
 * care about are forwarded; raw stdout goes through `log` events
 * elsewhere.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function forwardPulumiEvent(e: any, emit: (e: BootstrapEvent) => void): void {
  const rp = e?.resourcePreEvent?.metadata;
  const ro = e?.resOutputsEvent?.metadata;
  const meta = rp ?? ro;
  if (!meta) return;

  const opMap: Record<string, 'create' | 'update' | 'delete' | 'same' | 'replace'> = {
    create: 'create',
    'create-replacement': 'replace',
    update: 'update',
    delete: 'delete',
    'delete-replaced': 'replace',
    replace: 'replace',
    same: 'same',
  };

  const op = opMap[String(meta.op)];
  if (!op) return;

  emit({
    type: 'resource',
    op,
    resourceType: String(meta.type ?? ''),
    name:
      String(meta.urn ?? '')
        .split('::')
        .pop() ?? '',
  });
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
