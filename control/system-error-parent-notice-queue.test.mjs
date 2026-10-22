import test from 'node:test';
import assert from 'node:assert/strict';
import { runCycle, parentNoticeKey, defaultConfig, eligibility } from './system-error-recovery.mjs';
const clone = x => structuredClone(x);
function record(id, parentId, native = false) {
  return { thread: { id, parentThreadId: parentId, canAcceptDirectInput: !native, createdAt: 100,
    source: native ? { subAgent: { thread_spawn: { parent_thread_id: parentId } } } : 'vscode',
    threadSource: native ? 'subagent' : 'user', cwd: 'C:/original', model: 'gpt-6.1-sol',
    modelProvider: 'openai', reasoningEffort: 'high', status: { type: 'idle' } },
    turns: [{ id: 'failure-' + id, startedAt: 150, status: 'failed',
      error: { codexErrorInfo: 'serverOverloaded', message: 'Selected model is at capacity.' } }], goal: null };
}
function activeParent(id, paused = false) {
  const r = record(id, null); r.thread.status = { type: 'active' };
  r.turns = [{ id: 'active-' + id, status: 'inProgress' }];
  r.goal = { status: paused ? 'paused' : 'active', objective: 'Original work', createdAt: 100, updatedAt: 120,
    tokenBudget: 10000, tokensUsed: 50, timeUsedSeconds: 3 };
  return r;
}
function storage() {
  const notices = new Map(), recoveries = new Map();
  return { notices, recoveries, state: null,
    getNotice: k => notices.get(k), createNotice(k, v) { assert.equal(notices.has(k), false); notices.set(k, clone(v)); },
    updateNotice(k, v) { notices.set(k, clone(v)); },
    pendingNotices: () => [...notices.values()].filter(x => x.phase.startsWith('pending-')),
    getRecovery: (id, turn) => recoveries.get(JSON.stringify([id, turn])),
    recoveryRecords: () => [...recoveries.values()].filter(x => x.acceptedTurnId || x.goalRestored),
    exists: k => [...recoveries.values()].some(x => x.key === k),
    existingEpisode: (id, turn) => recoveries.has(JSON.stringify([id, turn])),
    create(k, v) { recoveries.set(JSON.stringify([v.threadId, v.failedTurnId]), clone(v)); },
    update(k, v) { recoveries.set(JSON.stringify([v.threadId, v.failedTurnId]), clone(v)); },
    saveState(s) { this.state = clone(s); }, allowed: () => true };
}
function mocked(records, listed, onChildStart) {
  const calls = [];
  return { calls, async call(method, params) {
    calls.push({ method, params: clone(params) });
    if (method === 'thread/list') return { data: listed.map(id => ({ id })), nextCursor: null };
    if (method === 'thread/loaded/list') return { data: [] };
    if (method === 'account/rateLimits/read') return { ordinaryUsageAllowed: true, rateLimits: { primary: { usedPercent: 20 }, spendControlReached: false } };
    const r = records.get(params.threadId); assert.ok(r, 'only genuine configured fixture IDs may be read');
    if (method === 'thread/read' || method === 'thread/resume') return { thread: clone(r.thread) };
    if (method === 'thread/turns/list') return { data: clone(r.turns) };
    if (method === 'thread/goal/get') { assert.equal(r.thread.canAcceptDirectInput, true); return { goal: clone(r.goal) }; }
    if (method === 'turn/steer') return { turnId: params.expectedTurnId };
    if (method === 'turn/start') {
      r.thread.status = { type: 'active' }; r.turns.unshift({ id: 'accepted-' + params.threadId, status: 'inProgress', startedAt: 200 });
      onChildStart?.(params.threadId); return { turn: { id: r.turns[0].id } };
    }
    throw new Error('Unexpected ' + method);
  } };
}
test('parent notice queue rotates paused parents and reserves opportunity for new native failure', async () => {
  const st = storage(), state = { threads: {} }, rows = new Map();
  const old = ['c0', 'c1', 'c2'].map(id => ({ id, key: parentNoticeKey(id, 'failure-' + id, 'native-failure') }))
    .sort((a, b) => a.key.localeCompare(b.key));
  for (let i = 0; i < old.length; i++) {
    const x = old[i], parentId = 'p-' + x.id; rows.set(x.id, record(x.id, parentId, true));
    rows.set(parentId, activeParent(parentId, i < 2));
    st.notices.set(x.key, { schemaVersion: 1, key: x.key, childId: x.id, failedTurnId: 'failure-' + x.id,
      kind: 'native-failure', parentId, phase: 'pending-parent' });
  }
  rows.set('new', record('new', 'p-new', true)); rows.set('p-new', activeParent('p-new'));
  const c = mocked(rows, [...old.map(x => x.id), 'new']);
  await runCycle(c, defaultConfig, state, st, () => 210000);
  assert.equal(c.calls.filter(x => x.method === 'turn/steer' && x.params.threadId === 'p-new').length, 1);
  for (let i = 0; i < 3; i++) await runCycle(c, defaultConfig, state, st, () => 220000 + i * 1000);
  assert.equal(c.calls.filter(x => x.method === 'turn/steer' && x.params.threadId === 'p-' + old[2].id).length, 1);
  for (const x of old.slice(0, 2)) assert.equal(st.notices.get(x.key).phase, 'pending-parent');
});
test('ordinary direct-input parent recovery deferred after acceptance is delivered next cycle without another recovery', async () => {
  const child = record('ordinary', 'parent'), rows = new Map([['ordinary', child], ['parent', activeParent('parent')]]);
  assert.equal(eligibility(child.thread, child.turns, child.goal), 'eligible');
  const st = storage(), state = { threads: {} }; let clock = 210000;
  const c = mocked(rows, ['ordinary'], id => { if (id === 'ordinary') clock += 50000; });
  // This fixture explicitly exercises an opted-in deadline, not a default cap.
  const config = { ...defaultConfig, cycleBudgetMs: 45000 };
  const one = await runCycle(c, config, state, st, () => clock);
  assert.equal(one.resumed, 1); assert.equal(one.results[0].parentNotice.action, 'notice-cycle-deferred');
  const key = parentNoticeKey('ordinary', 'failure-ordinary', 'recovery');
  assert.equal(st.notices.get(key).phase, 'pending-read');
  await runCycle(c, config, state, st, () => clock);
  assert.equal(st.notices.get(key).phase, 'accepted');
  assert.equal(c.calls.filter(x => x.method === 'turn/start' && x.params.threadId === 'ordinary').length, 1);
  assert.equal(c.calls.filter(x => x.method === 'turn/steer' && x.params.threadId === 'parent').length, 1);
  assert.equal(st.recoveries.size, 1);
});
test('parent notice queue reconstructs accepted or goalRestored records after crash before enqueue', async () => {
  for (const proof of [{ acceptedTurnId: 'new-child', phase: 'accepted' }, { goalRestored: true, phase: 'unknown-no-resend' }]) {
    const child = record('ordinary', 'parent'); child.thread.status = { type: 'active' };
    child.turns = [{ id: 'new-child', status: 'inProgress', startedAt: 200 }];
    const rows = new Map([['ordinary', child], ['parent', activeParent('parent')]]), st = storage();
    const recovery = { schemaVersion: 1, key: 'retained-recovery-key', threadId: 'ordinary', failedTurnId: 'failure-ordinary', ...proof };
    st.recoveries.set(JSON.stringify(['ordinary', 'failure-ordinary']), clone(recovery));
    const c = mocked(rows, ['ordinary']), state = { threads: {} };
    await runCycle(c, defaultConfig, state, st, () => 210000);
    await runCycle(c, defaultConfig, state, st, () => 220000);
    assert.equal(st.notices.get(parentNoticeKey('ordinary', 'failure-ordinary', 'recovery')).phase, 'accepted');
    assert.equal(c.calls.filter(x => x.method === 'turn/steer').length, 1);
    assert.equal(c.calls.some(x => ['turn/start', 'thread/resume', 'thread/goal/set'].includes(x.method)), false);
    assert.deepEqual(st.recoveries.get(JSON.stringify(['ordinary', 'failure-ordinary'])), recovery);
  }
});
