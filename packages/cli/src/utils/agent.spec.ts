import * as path from 'node:path';
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
    // The agent argv is shell-quoted per token (interactive is just
    // `claude`) so it nests safely inside runAgent's tmux wrapper.
    expect(line.endsWith(" 'claude'")).toBe(true);
    expect(line).toContain(`HTTPS_PROXY=${PROXY}`);
    expect(line).toContain(`https_proxy=${PROXY}`);
    expect(line).toContain('CLAUDE_CODE_CERT_STORE=bundled,system');
    expect(line).toContain(`ANTHROPIC_API_KEY=${ANTHROPIC_PLACEHOLDER_KEY}`);
  });

  it('bypasses the proxy only for loopback + cluster-internal hosts', () => {
    expect(line).toContain('NO_PROXY=localhost,127.0.0.1,::1');
    // api.anthropic.com must NOT be in NO_PROXY — it must traverse the broker.
    expect(line).not.toContain(ANTHROPIC_HOST);
  });

  it('shell-quotes a multi-word + embedded-single-quote autonomous task', () => {
    // Regression: the old code spliced the task unquoted, so a multi-word
    // prompt mis-parsed (`claude -p fix the test` → only `fix`) and a `'`
    // broke out of the tmux wrapper into arbitrary in-guest exec.
    const task = "fix the test; it's broken";
    const auto = composeLaunchLine(claudeCodeAdapter, PROXY, { mode: 'autonomous', task });
    // The whole prompt is ONE quoted `-p` argument — not split on spaces,
    // not terminated early by the `;`.
    expect(auto).toContain("'-p' 'fix the test; it'\\''s broken'");
    // The embedded single quote is rendered via the POSIX '\'' trick, so
    // it cannot break out of the wrapper.
    expect(auto).toContain("'\\''");
    // The autonomous flags are present and quoted.
    expect(auto).toContain("'--output-format' 'json'");
    expect(auto).toContain("'--dangerously-skip-permissions'");
  });
});

describe('printKeyHelperCommand', () => {
  it('pins the absolute interpreter + a stable agent entry, ending in print-key', () => {
    const cmd = printKeyHelperCommand();
    expect(cmd.endsWith('print-key')).toBe(true);
    // First quoted token is the absolute interpreter (execPath).
    const firstQuoted = cmd.match(/^'([^']+)'/)?.[1];
    expect(firstQuoted).toBe(process.execPath);
    expect(firstQuoted?.startsWith('/')).toBe(true);
    // The node/interpreter path targets the runnable agent entry directly.
    expect(cmd).toContain('appliance-agent.js');
  });

  it('ignores a dispatcher-clobbered process.argv[1]', () => {
    // appliance.ts rewrites process.argv[1] to the literal 'appliance-agent'
    // before importing the agent module. The helper must resolve a stable
    // module-relative entry, NOT a bogus cwd-relative path from argv[1]
    // (which would exit non-zero → every brokered request 502s under node).
    const saved = process.argv;
    try {
      process.argv = [process.execPath, 'appliance-agent', 'print-key'];
      const cmd = printKeyHelperCommand();
      // Not the bogus cwd-resolved literal.
      expect(cmd).not.toContain(`'${path.resolve('appliance-agent')}'`);
      // The stable, runnable entry instead.
      expect(cmd).toContain('appliance-agent.js');
      expect(cmd.endsWith('print-key')).toBe(true);
    } finally {
      process.argv = saved;
    }
  });
});
