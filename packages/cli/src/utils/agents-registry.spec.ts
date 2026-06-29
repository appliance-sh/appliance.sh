import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';

import {
  type AgentRecord,
  agentIdFromSession,
  findAgent,
  reconcileStatuses,
  readRegistry,
  registryFileFor,
  removeAgent,
  updateAgentStatus,
  upsertAgent,
} from './agents-registry.js';

function rec(over: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: 'aaaa',
    type: 'claude-code',
    status: 'running',
    sessionId: 'agent-aaaa',
    launchedAt: '2026-06-29T00:00:00.000Z',
    vm: 'appliance-sbx',
    ...over,
  };
}

describe('agents-registry persistence', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-registry-'));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('returns [] for a missing registry', () => {
    expect(readRegistry(root)).toEqual([]);
  });

  it('upserts then reads back roundtrip, writing { agents } at .appliance/agents.json', () => {
    upsertAgent(rec({ id: 'one', sessionId: 'agent-one' }), root);
    const file = registryFileFor(root);
    expect(fs.existsSync(file)).toBe(true);
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(Array.isArray(onDisk.agents)).toBe(true);
    expect(readRegistry(root).map((a) => a.id)).toEqual(['one']);
  });

  it('upsert replaces an existing entry by id and appends new ones', () => {
    upsertAgent(rec({ id: 'one', sessionId: 'agent-one', task: 'first' }), root);
    upsertAgent(rec({ id: 'one', sessionId: 'agent-one', task: 'second', status: 'done' }), root);
    upsertAgent(rec({ id: 'two', sessionId: 'agent-two' }), root);
    const agents = readRegistry(root);
    expect(agents).toHaveLength(2);
    const one = agents.find((a) => a.id === 'one');
    expect(one?.task).toBe('second');
    expect(one?.status).toBe('done');
  });

  it('tolerates a corrupt file (returns [])', () => {
    const file = registryFileFor(root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{ not valid json');
    expect(readRegistry(root)).toEqual([]);
  });

  it('drops non-conforming entries but keeps valid ones', () => {
    const file = registryFileFor(root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ agents: [{ bogus: true }, rec({ id: 'ok', sessionId: 'agent-ok' })] }));
    expect(readRegistry(root).map((a) => a.id)).toEqual(['ok']);
  });

  it('updateAgentStatus + removeAgent operate by id', () => {
    upsertAgent(rec({ id: 'one', sessionId: 'agent-one' }), root);
    expect(updateAgentStatus('one', 'exited', root)?.status).toBe('exited');
    expect(readRegistry(root)[0].status).toBe('exited');
    expect(removeAgent('one', root)?.id).toBe('one');
    expect(readRegistry(root)).toEqual([]);
    expect(removeAgent('nope', root)).toBeNull();
  });
});

describe('findAgent resolution', () => {
  const agents = [rec({ id: '7f3c', sessionId: 'agent-7f3c' }), rec({ id: '9a01', sessionId: 'agent-9a01' })];

  it('matches the bare id, the full session id, and the agent-<id> form', () => {
    expect(findAgent('7f3c', agents)?.id).toBe('7f3c');
    expect(findAgent('agent-7f3c', agents)?.id).toBe('7f3c');
  });

  it('matches an unambiguous prefix but not an ambiguous/absent one', () => {
    expect(findAgent('9a', agents)?.id).toBe('9a01');
    expect(findAgent('zz', agents)).toBeNull();
  });

  it('agentIdFromSession strips the agent- prefix', () => {
    expect(agentIdFromSession('agent-7f3c')).toBe('7f3c');
  });
});

describe('reconcileStatuses', () => {
  const vmOf = (a: AgentRecord) => a.vm ?? 'appliance-sbx';

  it('flips a running entry whose session vanished to exited', () => {
    const live = new Map<string, Set<string> | null>([['appliance-sbx', new Set<string>()]]);
    const { agents, changed, live: liveness } = reconcileStatuses([rec({ sessionId: 'agent-gone' })], live, vmOf);
    expect(changed).toBe(true);
    expect(agents[0].status).toBe('exited');
    expect(liveness['agent-gone']).toBe(false);
  });

  it('keeps a running entry whose session is live', () => {
    const live = new Map<string, Set<string> | null>([['appliance-sbx', new Set(['agent-live'])]]);
    const { agents, changed, live: liveness } = reconcileStatuses([rec({ sessionId: 'agent-live' })], live, vmOf);
    expect(changed).toBe(false);
    expect(agents[0].status).toBe('running');
    expect(liveness['agent-live']).toBe(true);
  });

  it('leaves agents untouched and reports null liveness when the VM is unreachable', () => {
    const live = new Map<string, Set<string> | null>([['appliance-sbx', null]]);
    const { agents, changed, live: liveness } = reconcileStatuses([rec({ sessionId: 'agent-x' })], live, vmOf);
    expect(changed).toBe(false);
    expect(agents[0].status).toBe('running');
    expect(liveness['agent-x']).toBeNull();
  });

  it('never resurrects a terminal (done/error/exited) status', () => {
    const live = new Map<string, Set<string> | null>([['appliance-sbx', new Set<string>()]]);
    const done = rec({ sessionId: 'agent-done', status: 'done' });
    const { agents, changed } = reconcileStatuses([done], live, vmOf);
    expect(changed).toBe(false);
    expect(agents[0].status).toBe('done');
  });
});
