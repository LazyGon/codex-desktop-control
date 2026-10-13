import test from 'node:test';
import assert from 'node:assert/strict';
import { parentRelationship, parentNoticeKey, notifyParent, snapshot, runCycle, defaultConfig } from './system-error-recovery.mjs';
const clone = x => structuredClone(x);
const child = () => ({ thread: { id: 'child', parentThreadId: 'parent', threadSource: 'subagent',
  source: { subAgent: { thread_spawn: { parent_thread_id: 'parent', depth: 1, agent_path: '/root/child' } } },
  canAcceptDirectInput: false, cwd: 'C:/retained', model: 'gpt-6.1-sol', modelProvider: 'openai',
  reasoningEffort: 'high', createdAt: 100, status: { type: 'idle' } }, goal: null,
  turns: [{ id: 'failed-child', startedAt: 150, status: 'failed', error: { codexErrorInfo: 'serverOverloaded', message: 'Selected model is at capacity.' } }] });
const parent = () => ({ thread: { id: 'parent', parentThreadId: null, canAcceptDirectInput: true,
  cwd: 'C:/retained', model: 'gpt-6.1-sol', modelProvider: 'openai', reasoningEffort: 'high', status: { type: 'active' } },
  turns: [{ id: 'active-parent', status: 'inProgress', error: null }],
  goal: { objective: 'Original parent work', status: 'active', tokenBudget: 10000, tokensUsed: 100, createdAt: 50, updatedAt: 100 } });
function store() {
  const notices = new Map(), recoveries = new Map();
  return { notices, recoveries, getNotice: k => notices.get(k),
    createNotice(k, v) { assert.equal(notices.has(k), false); notices.set(k, clone(v)); },
    updateNotice(k, v) { notices.set(k, clone(v)); },
    getRecovery: (id, turn) => recoveries.get(JSON.stringify([id, turn])),
    pendingNotices: () => [...notices.values()].filter(v => v.phase.startsWith('pending-')),
    allowed: () => true, saveState() {}, exists: () => false };
}
function client(c = child(), p = parent(), { failSteer = false } = {}) {
  const calls = [];
  return { calls, c, p, async call(m, args) {
    calls.push({ method: m, params: clone(args) });
    if (m === 'thread/list') return { data: [{ id: 'child' }], nextCursor: null };
    if (m === 'thread/loaded/list') return { data: [] };
    if (m === 'account/rateLimits/read') return { ordinaryUsageAllowed: true, rateLimits: { spendControlReached: false, primary: { usedPercent: 20 } } };
    const r = args.threadId === 'child' ? c : p;
    if (m === 'thread/read') return { thread: clone(r.thread) };
    if (m === 'thread/turns/list') return { data: clone(r.turns) };
    if (m === 'thread/goal/get') { assert.notEqual(args.threadId, 'child', 'native unsupported goal API must not be queried'); return { goal: clone(r.goal) }; }
    if (m === 'thread/resume') { assert.equal(args.threadId, 'parent'); return { thread: clone(p.thread) }; }
    if (m === 'turn/steer') { if (failSteer) throw new Error('Response unavailable after dispatch'); return { turnId: args.expectedTurnId }; }
    if (m === 'turn/start') return { turn: { id: 'parent-notice-turn' } };
    throw new Error('Unexpected ' + m);
  } };
}
test('parent notice reads exact actual snake-case metadata and rejects conflicting/self/missing target', () => {
  assert.deepEqual(parentRelationship(child().thread), { parentId: 'parent', native: true, invalid: false });
  const fallback = child().thread; delete fallback.parentThreadId;
  assert.equal(parentRelationship(fallback).parentId, 'parent');
  const bad = child().thread; bad.parentThreadId = 'other'; assert.equal(parentRelationship(bad).invalid, true);
  const self = child().thread; self.parentThreadId = 'child'; assert.equal(parentRelationship(self).invalid, true);
  assert.equal(parentRelationship({ id: 'root', parentThreadId: null, source: 'vscode' }).parentId, null);
});
test('parent notice native snapshot skips unsupported goal API then active exact parent receives one steer', async () => {
  const c = client(), st = store();
  const s = await snapshot(c, 'child'); assert.equal(s.nativeGoalNotRead, true);
  const r = await notifyParent(c, s, 'failed-child', 'native-failure', st, defaultConfig);
  assert.equal(r.action, 'parent-notified'); assert.equal(r.method, 'turn/steer');
  const sent = c.calls.find(x => x.method === 'turn/steer');
  assert.equal(sent.params.threadId, 'parent'); assert.equal(sent.params.expectedTurnId, 'active-parent');
  assert.deepEqual(Object.keys(sent.params).sort(), ['clientUserMessageId', 'expectedTurnId', 'input', 'threadId']);
  assert.equal(c.calls.some(x => ['thread/resume', 'turn/start', 'thread/goal/set'].includes(x.method)), false);
  await notifyParent(c, s, 'failed-child', 'native-failure', st, defaultConfig);
  assert.equal(c.calls.filter(x => x.method === 'turn/steer').length, 1);
});
test('parent notice paused/completed/budget/excluded and ambiguous blocked parents remain pending, never started', async () => {
  for (const mode of ['paused', 'completed', 'blocked', 'budget', 'excluded']) {
    const p = parent(); if (mode === 'budget') p.goal.tokensUsed = p.goal.tokenBudget;
    else if (mode !== 'excluded') p.goal.status = mode;
    const cfg = { ...defaultConfig, excludedThreadIds: mode === 'excluded' ? ['parent'] : [] };
    const c = client(child(), p), st = store();
    const r = await notifyParent(c, child(), 'failed-child', 'native-failure', st, cfg);
    assert.equal(r.action, 'pending-parent');
    assert.equal(c.calls.some(x => ['turn/steer', 'turn/start', 'thread/resume', 'thread/goal/set'].includes(x.method)), false);
  }
});
test('parent notice idle existing active goal starts same parent without goal/settings changes', async () => {
  const p = parent(); p.thread.status = { type: 'idle' }; p.turns = [{ id: 'done', status: 'completed' }];
  const c = client(child(), p), st = store();
  const r = await notifyParent(c, child(), 'failed-child', 'native-failure', st, defaultConfig);
  assert.equal(r.startedParentTurn, true); assert.equal(r.turnId, 'parent-notice-turn');
  assert.deepEqual(c.calls.find(x => x.method === 'thread/resume').params, { threadId: 'parent', excludeTurns: true });
  assert.equal(c.calls.some(x => x.method === 'thread/goal/set'), false);
});
test('parent notice UNKNOWN has independent durable claim and never resends or repeats child recovery', async () => {
  const c = client(child(), parent(), { failSteer: true }), st = store();
  const r = await notifyParent(c, child(), 'failed-child', 'native-failure', st, defaultConfig);
  assert.equal(r.action, 'unknown-no-resend');
  await notifyParent(c, child(), 'failed-child', 'native-failure', st, defaultConfig);
  assert.equal(c.calls.filter(x => x.method === 'turn/steer').length, 1);
  assert.equal(c.calls.some(x => x.method === 'thread/resume' && x.params.threadId === 'child'), false);
  assert.notEqual(parentNoticeKey('child', 'failed-child', 'native-failure'), parentNoticeKey('child', 'new-failure', 'native-failure'));
});
test('parent notice runCycle ignores superseded completed/interrupted child errors', async () => {
  for (const status of ['completed', 'interrupted', 'inProgress']) {
    const s = child(); s.turns.unshift({ id: 'newer', startedAt: 200, status, error: null });
    const c = client(s), st = store();
    const r = await runCycle(c, defaultConfig, { threads: {} }, st);
    assert.equal(r.parentNotices.length, 0); assert.equal(st.notices.size, 0);
    assert.equal(c.calls.some(x => ['turn/steer', 'turn/start', 'thread/resume'].includes(x.method)), false);
  }
});
test('parent notice inherited pre-birth parent error is not a native child failure', async () => {
  const s = child(); s.turns[0].startedAt = 99;
  const c = client(s), st = store();
  const r = await runCycle(c, defaultConfig, { threads: {} }, st);
  assert.equal(r.parentNotices.length, 0); assert.equal(st.notices.size, 0);
  assert.equal(c.calls.some(x => ['turn/steer', 'turn/start', 'thread/resume'].includes(x.method)), false);
});
test('parent notice confirmed recovery and genuine parent required; root recovery invents no target', async () => {
  const c = client(), st = store();
  assert.equal((await notifyParent(c, child(), 'failed-child', 'recovery', st, defaultConfig)).action, 'no-confirmed-recovery');
  st.recoveries.set(JSON.stringify(['child', 'failed-child']), { acceptedTurnId: 'new-child', phase: 'accepted' });
  assert.equal((await notifyParent(c, child(), 'failed-child', 'recovery', st, defaultConfig)).action, 'parent-notified');
  const root = child(); root.thread = { ...parent().thread, id: 'root', parentThreadId: null, source: 'vscode' };
  assert.equal((await notifyParent(c, root, 'f', 'recovery', st, defaultConfig)).action, 'no-genuine-parent');
});
