import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import {
  ANTHROPIC_HOST,
  ANTHROPIC_PLACEHOLDER_KEY,
  adapterForType,
  agentResultPaths,
  classifyAutonomousResult,
  claudeCodeAdapter,
  composeAutonomousCaptureLine,
  composeLaunchLine,
  printKeyHelperCommand,
  readAutonomousResultFromFiles,
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

describe('adapterForType', () => {
  it('resolves the claude-code adapter and rejects unknown types', () => {
    expect(adapterForType('claude-code')).toBe(claudeCodeAdapter);
    expect(adapterForType('aider')).toBeNull();
  });
});

describe('autonomous result capture (A6)', () => {
  it('agentResultPaths puts host + guest results under .appliance/agent-results', () => {
    const p = agentResultPaths('/work/proj', 'agent-7f3c');
    expect(p.hostJson).toBe(path.join('/work/proj', '.appliance', 'agent-results', 'agent-7f3c.json'));
    expect(p.hostRc).toBe(path.join('/work/proj', '.appliance', 'agent-results', 'agent-7f3c.rc'));
    expect(p.guestJson).toBe('/persist/workspace/.appliance/agent-results/agent-7f3c.json');
    expect(p.guestRc).toBe('/persist/workspace/.appliance/agent-results/agent-7f3c.rc');
    expect(p.guestDir).toBe('/persist/workspace/.appliance/agent-results');
  });

  it('composeAutonomousCaptureLine redirects the JSON result + records the exit code (no exec)', () => {
    const paths = agentResultPaths('/work/proj', 'agent-7f3c');
    const line = composeAutonomousCaptureLine(claudeCodeAdapter, PROXY, { mode: 'autonomous', task: 'fix it' }, paths);
    // Non-exec: the shell must outlive claude to write the rc file.
    expect(line).not.toContain('exec ');
    expect(line.startsWith('cd /persist/workspace; mkdir -p ')).toBe(true);
    // The headless argv is quoted, stdout is redirected to the result file,
    // and `$?` is recorded to the sibling rc file.
    expect(line).toContain("'claude' '-p' 'fix it' '--output-format' 'json' '--dangerously-skip-permissions'");
    expect(line).toContain(`> '${paths.guestJson}'`);
    expect(line).toContain(`echo $? > '${paths.guestRc}'`);
    // Still wired through the broker env.
    expect(line).toContain(`HTTPS_PROXY=${PROXY}`);
    expect(line).toContain(`ANTHROPIC_API_KEY=${ANTHROPIC_PLACEHOLDER_KEY}`);
  });

  it('composeLaunchLine(exec=false) drops the exec so the sentinel can fire after the agent', () => {
    const line = composeLaunchLine(claudeCodeAdapter, PROXY, { mode: 'autonomous', task: 'go' }, false);
    expect(line.startsWith('cd /persist/workspace; env ')).toBe(true);
    expect(line).not.toContain('exec env');
    expect(line).toContain("'claude' '-p' 'go'");
  });

  it('classifyAutonomousResult: done only on exit 0 + a non-error parse', () => {
    const done = classifyAutonomousResult(0, '{"is_error":false,"result":"all green"}', claudeCodeAdapter);
    expect(done).toEqual({ status: 'done', exitCode: 0, summary: 'all green' });

    // is_error result → error even on a zero exit.
    const flagged = classifyAutonomousResult(0, '{"is_error":true,"result":"Invalid API key"}', claudeCodeAdapter);
    expect(flagged).toEqual({ status: 'error', exitCode: 0, summary: 'Invalid API key' });

    // Non-zero exit → error, with a synthesized summary when nothing parsed.
    const crashed = classifyAutonomousResult(1, 'boom, not json', claudeCodeAdapter);
    expect(crashed.status).toBe('error');
    expect(crashed.exitCode).toBe(1);
    expect(crashed.summary).toContain('exit 1');

    // Missing exit code (rc file absent) → error.
    expect(classifyAutonomousResult(null, '', claudeCodeAdapter).status).toBe('error');
  });
});

describe('readAutonomousResultFromFiles (A6)', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-result-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reads the captured JSON + rc and classifies done', () => {
    const json = path.join(dir, 'r.json');
    const rc = path.join(dir, 'r.rc');
    fs.writeFileSync(json, '{"is_error":false,"result":"shipped"}\n');
    fs.writeFileSync(rc, '0\n');
    expect(readAutonomousResultFromFiles(json, rc, claudeCodeAdapter)).toEqual({
      status: 'done',
      exitCode: 0,
      summary: 'shipped',
    });
  });

  it('classifies error from a non-zero rc even with a parseable result', () => {
    const json = path.join(dir, 'r.json');
    const rc = path.join(dir, 'r.rc');
    fs.writeFileSync(json, '{"is_error":false,"result":"partial"}');
    fs.writeFileSync(rc, '7');
    const res = readAutonomousResultFromFiles(json, rc, claudeCodeAdapter);
    expect(res?.status).toBe('error');
    expect(res?.exitCode).toBe(7);
  });

  it('returns null when the result file is absent (run produced nothing)', () => {
    expect(
      readAutonomousResultFromFiles(path.join(dir, 'missing.json'), path.join(dir, 'missing.rc'), claudeCodeAdapter)
    ).toBeNull();
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
