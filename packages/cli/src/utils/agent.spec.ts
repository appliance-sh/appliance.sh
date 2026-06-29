import { describe, it, expect } from 'vitest';
import {
  ANTHROPIC_HOST,
  ANTHROPIC_PLACEHOLDER_KEY,
  claudeCodeAdapter,
  composeLaunchLine,
  printKeyHelperCommand,
} from './agent.js';

const PROXY = 'http://192.168.64.1:5053';

describe('claudeCodeAdapter', () => {
  it('brokers the Anthropic x-api-key host-side, never capturing it', () => {
    expect(claudeCodeAdapter.credHosts).toEqual([
      { host: ANTHROPIC_HOST, inject: true, capture: false, header: 'x-api-key' },
    ]);
    // The placeholder is inert and lives only in the guest env.
    expect(claudeCodeAdapter.placeholderEnv).toEqual({ ANTHROPIC_API_KEY: ANTHROPIC_PLACEHOLDER_KEY });
  });

  it('launches a bare TTY interactively and `claude -p … json` autonomously', () => {
    expect(claudeCodeAdapter.launchArgv({ mode: 'interactive' })).toEqual(['claude']);
    expect(claudeCodeAdapter.launchArgv({ mode: 'autonomous', task: 'fix it' })).toEqual([
      'claude',
      '-p',
      'fix it',
      '--output-format',
      'json',
      '--dangerously-skip-permissions',
    ]);
  });

  it('parses the autonomous JSON result line', () => {
    const ok = claudeCodeAdapter.parseResult?.('{"is_error":false,"result":"done"}');
    expect(ok).toEqual({ ok: true, summary: 'done' });
    const err = claudeCodeAdapter.parseResult?.('{"is_error":true,"result":"Invalid API key"}');
    expect(err).toEqual({ ok: false, summary: 'Invalid API key' });
  });
});

describe('composeLaunchLine', () => {
  const line = composeLaunchLine(claudeCodeAdapter, PROXY, { mode: 'interactive' });

  it('cds to the workspace and execs claude under the proxy + placeholder env', () => {
    expect(line.startsWith('cd /persist/workspace; exec env ')).toBe(true);
    expect(line.endsWith(' claude')).toBe(true);
    expect(line).toContain(`HTTPS_PROXY=${PROXY}`);
    expect(line).toContain(`https_proxy=${PROXY}`);
    expect(line).toContain('CLAUDE_CODE_CERT_STORE=bundled,system');
    expect(line).toContain(`ANTHROPIC_API_KEY=${ANTHROPIC_PLACEHOLDER_KEY}`);
  });

  it('embeds no single quote, so it stays a single quoted tmux argument', () => {
    // The launch line is wrapped in single quotes for `tmux new-session`;
    // a stray single quote would break that out and the launch.
    expect(line.includes("'")).toBe(false);
  });

  it('bypasses the proxy only for loopback + cluster-internal hosts', () => {
    expect(line).toContain('NO_PROXY=localhost,127.0.0.1,::1');
    // api.anthropic.com must NOT be in NO_PROXY — it must traverse the broker.
    expect(line).not.toContain(ANTHROPIC_HOST);
  });
});

describe('printKeyHelperCommand', () => {
  it('pins an absolute path and ends with `agent print-key`', () => {
    const cmd = printKeyHelperCommand();
    expect(cmd.endsWith('agent print-key')).toBe(true);
    // Absolute: the first quoted token is an absolute path.
    const firstQuoted = cmd.match(/^'([^']+)'/)?.[1];
    expect(firstQuoted?.startsWith('/')).toBe(true);
  });
});
