import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultConfig, eligibility, episodeKey, rateAvailable, runCycle, snapshot,
  goalIdentity, backoffMs, status, setEnabled, runOnce } from './system-error-recovery.mjs';
import { saveJson } from './shared-task-operations.mjs';

const clone = x => structuredClone(x);
const thread = id => ({ id, cwd: 'C:/retained/work', model: 'gpt-6.1-sol', modelProvider: 'openai',
  reasoningEffort: 'high', canAcceptDirectInput: true, status: { type: 'idle' }, parentThreadId: null });
const failed = id => ({ id, status: 'failed', startedAt: 100, completedAt: 200,
  error: { message: 'Selected model is at capacity. Please try a different model.', codexErrorInfo: 'serverOverloaded' } });
const goal = status => ({ status, objective: 'Retained original objective', tokenBudget: 123456,
  tokensUsed: 500, timeUsedSeconds: 8, createdAt: 50, updatedAt: status === 'active' ? 100 : 200 });
const rate = () => ({ ordinaryUsageAllowed: true,
  rateLimits: { primary: { usedPercent: 20 }, secondary: null, spendControlReached: false } });
function memoryStore() {
  const records = new Map(), updates = [];
  return { records, updates, state: null, exists: k => records.has(k),
    existingEpisode: (id, turn) => [...records.values()].some(x => x.threadId === id && x.failedTurnId === turn),
    create(k, v) { assert.equal(records.has(k), false); records.set(k, clone(v)); updates.push(v.phase); },
    update(k, v) { records.set(k, clone(v)); updates.push(v.phase); },
    saveState(s) { this.state = clone(s); }, allowed: () => true };
}
function mocked({ ids = ['task'], initialGoal = null, onRead, startError, resumeError, startNoId,
  afterReadError = false, rates = rate() } = {}) {
  const records = new Map(ids.map(id => [id, { thread: thread(id), turns: [failed('failed-' + id)], goal: clone(initialGoal) }]));
  const calls = [], counts = new Map();
  return { calls, records, async call(method, params) {
    calls.push({ method, params: clone(params) });
    const r = records.get(params?.threadId);
    if (method === 'thread/list') return { data: ids.map(id => ({ id })), nextCursor: null };
    if (method === 'thread/loaded/list') return { data: [] };
    if (method === 'account/rateLimits/read') return clone(rates);
    if (method === 'thread/read') {
      const n = counts.get(params.threadId) ?? 0; counts.set(params.threadId, n + 1);
      onRead?.(r, n, params.threadId);
      if (afterReadError && r.turns[0].id === 'accepted') throw new Error('Read unavailable');
      return { thread: clone(r.thread) };
    }
    if (method === 'thread/turns/list') return { data: clone(r.turns) };
    if (method === 'thread/goal/get') return { goal: clone(r.goal) };
    if (method === 'thread/resume') { if (resumeError) throw resumeError; return { thread: clone(r.thread) }; }
    if (method === 'thread/goal/set') {
      assert.deepEqual(params, { threadId: params.threadId, status: 'active' });
      r.goal.status = 'active'; return { goal: clone(r.goal) };
    }
    if (method === 'turn/start') {
      if (startError) throw startError;
      if (startNoId) return { turn: {} };
      r.turns = [{ id: 'accepted', status: 'inProgress', error: null }, ...r.turns];
      r.thread.status = { type: 'active' }; return { turn: { id: 'accepted' } };
    }
    throw new Error('Unexpected RPC ' + method);
  } };
}

test('actual capacity fixture is retryable only when latest terminal and ordinary', () => {
  assert.equal(eligibility(thread('t'), [failed('f')], null), 'eligible');
  assert.equal(eligibility(thread('t'), [{ id: 'new', status: 'inProgress' }, failed('f')], null), 'active');
  assert.equal(eligibility(thread('t'), [{ id: 'done', status: 'completed' }, failed('f')], null), 'no-latest-terminal-error');
  assert.equal(eligibility(thread('t'), [{ id: 'stop', status: 'interrupted', error: null }], null), 'no-latest-terminal-error');
  assert.equal(eligibility({ ...thread('t'), canAcceptDirectInput: null }, [failed('f')], null), 'not-confirmed-direct-input');
  assert.equal(eligibility({ ...thread('t'), parentThreadId: 'parent' }, [failed('f')], null), 'eligible');
  assert.equal(eligibility({ ...thread('t'), parentThreadId: 'parent', canAcceptDirectInput: false,
    source: { subAgent: { thread_spawn: { parent_thread_id: 'parent' } } } }, [failed('f')], null), 'native-child-owner-route');
  assert.equal(eligibility(thread('t'), [failed('f')], null, ['t']), 'excluded');
});
test('intentional/protected goal states and initial blocked do not resume', () => {
  for (const s of ['paused', 'complete', 'completed', 'budgetLimited', 'usageLimited']) {
    assert.equal(eligibility(thread('t'), [failed('f')], goal(s)), 'protected-goal');
  }
  assert.equal(eligibility(thread('t'), [failed('f')], goal('blocked')), 'blocked-cause-unproven');
});
test('rate guard matches top-level actual shape without depending on account/credit data', () => {
  assert.equal(rateAvailable(rate()), true);
  assert.equal(rateAvailable({ rateLimits: { ordinaryUsageAllowed: true } }), false);
  assert.equal(rateAvailable({ ...rate(), ordinaryUsageAllowed: false }), false);
  assert.equal(rateAvailable({ ...rate(), rateLimits: { spendControlReached: true } }), false);
  assert.equal(rateAvailable({ ...rate(), rateLimitsByLimitId: { extra: { primary: { usedPercent: 100 } } } }), false);
  assert.equal(rateAvailable({ ordinaryUsageAllowed: true }), false);
});
test('exhausted goal budget prevents recovery even with typed terminal system failure', async () => {
  for (const status of ['active', 'blocked']) {
    const g = goal(status); g.tokensUsed = g.tokenBudget;
    const c = mocked({ initialGoal: g }), st = memoryStore();
    const r = await runCycle(c, defaultConfig, { threads: {} }, st, () => 210000);
    assert.equal(r.results[0].action, 'goal-budget-exhausted-or-unconfirmed');
    assert.equal(c.calls.some(x => ['thread/resume', 'thread/goal/set', 'turn/start'].includes(x.method)), false);
    assert.equal(c.records.get('task').goal.tokensUsed, g.tokenBudget);
  }
});
test('permanent HTTP and unrecognized errors fail closed', () => {
  const f = failed('f'); f.error.codexErrorInfo = { httpConnectionFailed: { httpStatusCode: 401 } };
  assert.equal(eligibility(thread('t'), [f], null), 'permanent-http-error');
  f.error.codexErrorInfo = 'badRequest'; assert.equal(eligibility(thread('t'), [f], null), 'non-retryable-error');
  f.error = { ...failed('f').error, willRetry: true }; assert.equal(eligibility(thread('t'), [f], null), 'server-retrying');
});
test('snapshot distinguishes null goal from missing/failed goal read', async () => {
  const c = mocked(); assert.equal((await snapshot(c, 'task')).goal, null);
  const original = c.call.bind(c); c.call = (m, p) => m === 'thread/goal/get' ? Promise.resolve({}) : original(m, p);
  await assert.rejects(snapshot(c, 'task'), /Incomplete snapshot/);
});
test('same-thread successful continuation preserves config and accepted readback', async () => {
  const c = mocked(), s = { threads: {} }, st = memoryStore();
  const result = await runCycle(c, defaultConfig, s, st, () => 150000);
  assert.equal(result.resumed, 1); assert.equal(result.results[0].readback, 'verified');
  assert.deepEqual(c.calls.find(x => x.method === 'thread/resume').params, { threadId: 'task', excludeTurns: true });
  assert.deepEqual(Object.keys(c.calls.find(x => x.method === 'turn/start').params).sort(), ['clientUserMessageId', 'input', 'threadId']);
  assert.equal(c.calls.filter(x => x.method === 'thread/goal/set').length, 0);
  assert.ok(st.updates.indexOf('prepared') < st.updates.indexOf('session-dispatching'));
});
test('UNKNOWN turn/start and session/resume never resend the same failure episode', async () => {
  for (const option of [{ startError: new Error('Timed out after send') }, { resumeError: new Error('Connection closed') }, { startNoId: true }]) {
    const c = mocked(option), s = { threads: {} }, st = memoryStore();
    const one = await runCycle(c, defaultConfig, s, st, () => 150000);
    assert.equal(one.results[0].action, 'unknown-no-resend');
    const before = c.calls.filter(x => ['thread/resume', 'turn/start'].includes(x.method)).length;
    await runCycle(c, defaultConfig, s, st, () => 900000);
    assert.equal(c.calls.filter(x => ['thread/resume', 'turn/start'].includes(x.method)).length, before);
  }
});
test('accepted receipt remains accepted when live readback unavailable', async () => {
  const c = mocked({ afterReadError: true }), st = memoryStore();
  const r = await runCycle(c, defaultConfig, { threads: {} }, st, () => 150000);
  assert.equal(r.resumed, 1); assert.equal(r.results[0].readback, 'unavailable');
  assert.equal([...st.records.values()][0].phase, 'accepted');
});
test('intentional pause race after session restoration prevents goal/start mutation', async () => {
  const c = mocked({ initialGoal: goal('active'), onRead(r, n) { if (n === 2) r.goal.status = 'paused'; } });
  const r = await runCycle(c, defaultConfig, { threads: {} }, memoryStore(), () => 150000);
  assert.equal(r.results[0].action, 'changed-after-session');
  assert.equal(c.calls.filter(x => ['turn/start', 'thread/goal/set'].includes(x.method)).length, 0);
});
test('live config stop at dispatch boundary prevents start', async () => {
  const c = mocked(), st = memoryStore(); let checks = 0;
  st.allowed = () => ++checks < 3;
  const r = await runCycle(c, defaultConfig, { threads: {} }, st, () => 150000);
  assert.equal(r.results[0].action, 'config-stopped'); assert.equal(c.calls.some(x => x.method === 'turn/start'), false);
});
test('observed active exact inProgress turn permits bounded same-goal recovery after terminal failure', async () => {
  const c = mocked({ initialGoal: goal('active') }), s = { threads: {} }, st = memoryStore();
  const r = c.records.get('task'); r.turns[0].status = 'inProgress'; r.turns[0].error = null; r.thread.status = { type: 'active' };
  await runCycle(c, defaultConfig, s, st, () => 150000);
  r.turns = [failed('failed-task')]; r.thread.status = { type: 'idle' }; r.goal = goal('blocked');
  const identity = goalIdentity(r.goal), used = r.goal.tokensUsed;
  const after = await runCycle(c, defaultConfig, s, st, () => 210000);
  assert.equal(after.resumed, 1); assert.equal(r.goal.status, 'active');
  assert.equal(goalIdentity(r.goal), identity); assert.equal(r.goal.tokensUsed, used);
  assert.equal([...st.records.values()][0].recoveryObservation.turnId, 'failed-task');
});

test('goal auto-start visible only at pre-start retains exact active evidence for a fast next failure', async () => {
  const c = mocked({ initialGoal: goal('active'), onRead(r, n) {
    // The first post-goal read is stale; the pre-start snapshot first sees auto-start.
    if (n === 5) {
      r.turns = [{ id: 'goal-auto-start', status: 'inProgress', startedAt: 210, error: null }, ...r.turns];
      r.thread.status = { type: 'active' };
    }
  } }), s = { threads: {} }, st = memoryStore(), r = c.records.get('task');
  r.turns[0].status = 'inProgress'; r.turns[0].error = null; r.thread.status = { type: 'active' };
  await runCycle(c, defaultConfig, s, st, () => 150000);
  r.turns = [failed('failed-task')]; r.thread.status = { type: 'idle' }; r.goal = goal('blocked');
  await runCycle(c, defaultConfig, s, st, () => 210000);
  assert.equal(c.calls.filter(x => x.method === 'thread/goal/set').length, 1);
  assert.equal(c.calls.filter(x => x.method === 'turn/start').length, 0);
  assert.equal(st.state.threads.task.activeGoalObservation.turnId, 'goal-auto-start');
  assert.equal(st.state.threads.task.activeGoalObservation.turnStatus, 'inProgress');
  assert.equal(st.state.threads.task.activeGoalObservation.goalIdentity, goalIdentity(r.goal));
  assert.equal(st.state.threads.task.latestTurnId, 'goal-auto-start');
  assert.equal(st.state.threads.task.latestTurnStatus, 'inProgress');
  assert.equal(st.state.threads.task.recoveryObservation, undefined);
  assert.equal(st.state.threads.task.count, 1); assert.equal(st.state.threads.task.nextEligibleAt, 270000);
  r.turns = [{ ...failed('goal-auto-start'), startedAt: 210, completedAt: 248 }];
  r.thread.status = { type: 'idle' }; r.goal.status = 'blocked'; r.goal.updatedAt = 248;
  assert.equal(eligibility(r.thread, r.turns, r.goal, [], st.state.threads.task), 'eligible');
  const early = await runCycle(c, defaultConfig, s, st, () => 248000);
  assert.equal(early.results[0].action, 'backoff'); assert.equal(st.records.size, 1);
  const later = await runCycle(c, defaultConfig, s, st, () => 270000);
  assert.equal(later.resumed, 1); assert.equal(st.records.size, 2);
  assert.equal([...st.records.values()][1].recoveryObservation.turnId, 'goal-auto-start');
  assert.equal(s.threads.task.count, 2); assert.equal(s.threads.task.nextEligibleAt, 390000);
});

test('accepted recovery readback saves the new active turn without resetting retry count or backoff', async () => {
  const c = mocked({ initialGoal: goal('active') }), s = { threads: {} }, st = memoryStore(), r = c.records.get('task');
  const after = await runCycle(c, defaultConfig, s, st, () => 210000);
  assert.equal(after.resumed, 1); assert.equal(after.results[0].readback, 'verified');
  assert.equal(st.state.threads.task.activeGoalObservation.turnId, 'accepted');
  assert.equal(st.state.threads.task.activeGoalObservation.turnStatus, 'inProgress');
  assert.equal(st.state.threads.task.latestTurnId, 'accepted');
  assert.equal(st.state.threads.task.latestTurnStatus, 'inProgress');
  assert.equal(st.state.threads.task.goalStatus, 'active');
  assert.equal(st.state.threads.task.count, 1); assert.equal(st.state.threads.task.nextEligibleAt, 270000);
  r.turns = [{ ...failed('accepted'), startedAt: 210, completedAt: 248 }];
  r.thread.status = { type: 'idle' }; r.goal.status = 'blocked'; r.goal.updatedAt = 248;
  const early = await runCycle(c, defaultConfig, s, st, () => 248000);
  assert.equal(early.results[0].action, 'backoff'); assert.equal(st.records.size, 1);
  assert.equal(c.calls.filter(x => x.method === 'turn/start').length, 1);
  assert.equal(s.threads.task.count, 1); assert.equal(s.threads.task.nextEligibleAt, 270000);
});

test('pause, changed objective and exhausted budget remain protected during goal auto-start race', async () => {
  for (const [label, change, expected] of [
    ['pause', r => r.goal.status = 'paused', 'protected-goal'],
    ['objective', r => r.goal.objective = 'Different objective', 'blocked-cause-unproven'],
    ['budget', r => r.goal.tokensUsed = r.goal.tokenBudget, 'goal-budget-exhausted-or-unconfirmed'],
  ]) {
    const c = mocked({ initialGoal: goal('active'), onRead(r, n) {
      if (n === 5) {
        r.turns = [{ id: 'protected-auto-start', status: 'inProgress', startedAt: 210, error: null }, ...r.turns];
        r.thread.status = { type: 'active' }; change(r);
      }
    } }), s = { threads: {} }, st = memoryStore(), r = c.records.get('task');
    r.turns[0].status = 'inProgress'; r.turns[0].error = null; r.thread.status = { type: 'active' };
    await runCycle(c, defaultConfig, s, st, () => 150000);
    r.turns = [failed('failed-task')]; r.thread.status = { type: 'idle' }; r.goal = goal('blocked');
    await runCycle(c, defaultConfig, s, st, () => 210000);
    assert.equal(c.calls.filter(x => x.method === 'turn/start').length, 0, label);
    if (label !== 'budget') assert.notEqual(st.state.threads.task.activeGoalObservation?.turnId, 'protected-auto-start', label);
    r.turns = [{ ...failed('protected-auto-start'), startedAt: 210, completedAt: 248 }];
    r.thread.status = { type: 'idle' }; if (label !== 'pause') r.goal.status = 'blocked'; r.goal.updatedAt = 248;
    const later = await runCycle(c, defaultConfig, s, st, () => 270000);
    assert.equal(later.results[0].action, expected, label);
    assert.equal(st.records.size, 1, label);
    assert.equal(c.calls.filter(x => x.method === 'thread/goal/set').length, 1, label);
    assert.equal(c.calls.filter(x => x.method === 'turn/start').length, 0, label);
  }
});

test('accepted turn identity alone with unavailable readback never fabricates an inProgress observation', async () => {
  const c = mocked({ initialGoal: goal('active'), afterReadError: true }), s = { threads: {} }, st = memoryStore();
  const after = await runCycle(c, defaultConfig, s, st, () => 210000);
  assert.equal(after.resumed, 1); assert.equal(after.results[0].readback, 'unavailable');
  assert.notEqual(st.state.threads.task.activeGoalObservation?.turnId, 'accepted');
  const r = c.records.get('task'); r.thread.status = { type: 'idle' };
  assert.equal(eligibility(r.thread, [{ ...failed('accepted'), completedAt: 248 }],
    { ...r.goal, status: 'blocked', updatedAt: 248 }, [], st.state.threads.task), 'blocked-cause-unproven');
});
test('new goal/objective, later goal edit or different failure turn cannot reuse active observation', async () => {
  for (const change of [r => r.goal.objective = 'Different', r => r.goal.updatedAt = 201, r => r.turns[0].id = 'new-turn']) {
    const c = mocked({ initialGoal: goal('active') }), s = { threads: {} }, st = memoryStore(), r = c.records.get('task');
    r.turns[0].status = 'inProgress'; r.thread.status = { type: 'active' };
    await runCycle(c, defaultConfig, s, st, () => 150000);
    r.turns = [failed('failed-task')]; r.thread.status = { type: 'idle' }; r.goal = goal('blocked'); change(r);
    const result = await runCycle(c, defaultConfig, s, st, () => 210000);
    assert.equal(result.results[0].action, 'blocked-cause-unproven'); assert.equal(st.records.size, 0);
  }
});
test('fair queue makes bounded cycles reach tasks after first page position', async () => {
  const ids = Array.from({ length: 12 }, (_, i) => 't' + i), c = mocked({ ids }), s = { threads: {} }, st = memoryStore();
  for (const r of c.records.values()) r.turns[0].status = 'completed';
  const visited = new Set();
  for (let i = 0; i < 3; i++) {
    const r = await runCycle(c, { ...defaultConfig, maxThreadsPerCycle: 4 }, s, st, () => 150000);
    assert.equal(r.checked, 4); r.results.forEach(x => visited.add(x.id));
  }
  assert.equal(visited.size, 12);
});
test('new terminal failure gets a new episode key but retains backoff', async () => {
  const c = mocked(), s = { threads: {} }, st = memoryStore();
  await runCycle(c, defaultConfig, s, st, () => 150000);
  const r = c.records.get('task'); r.thread.status = { type: 'idle' }; r.turns = [failed('new-failure')];
  const early = await runCycle(c, defaultConfig, s, st, () => 151000); assert.equal(early.results[0].action, 'backoff');
  assert.notEqual(episodeKey('task', failed('a')), episodeKey('task', failed('b')));
  const later = await runCycle(c, defaultConfig, s, st, () => 211000); assert.equal(later.resumed, 1);
  assert.equal(st.records.size, 2); assert.equal(backoffMs(2), 120000);
});
test('altered error details never retry the same failed turn, including legacy journal key', async () => {
  const c = mocked(), st = memoryStore(), s = { threads: {} };
  const old = failed('failed-task'), decorated = clone(old);
  decorated.error.message = 'Later explanation'; decorated.error.additionalDetails = { retryDecoration: true };
  assert.equal(episodeKey('task', old), episodeKey('task', decorated));
  // Model the existing old key without rewriting or discarding its uncertainty.
  const legacyKey = 'a'.repeat(64);
  st.records.set(legacyKey, { schemaVersion: 1, key: legacyKey, threadId: 'task',
    failedTurnId: old.id, phase: 'unknown-no-resend' });
  c.records.get('task').turns = [decorated];
  const r = await runCycle(c, defaultConfig, s, st, () => 900000);
  assert.equal(r.results[0].action, 'episode-already-recorded');
  assert.equal(c.calls.some(x => ['thread/resume', 'thread/goal/set', 'turn/start'].includes(x.method)), false);
  assert.equal(st.records.size, 1); assert.equal(st.records.get(legacyKey).phase, 'unknown-no-resend');
});
test('dry-run performs only reads and creates no mutation journal', async () => {
  const c = mocked(), st = memoryStore();
  const r = await runCycle(c, defaultConfig, { threads: {} }, st, () => 150000, true);
  assert.equal(r.results[0].action, 'would-resume'); assert.equal(st.records.size, 0); assert.equal(st.state, null);
  assert.equal(c.calls.some(x => ['thread/resume', 'thread/goal/set', 'turn/start'].includes(x.method)), false);
});
test('durable stop/status and disabled execution need no server connection', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-recovery-test-'));
  try {
    saveJson(path.join(dir, 'config.json'), clone(defaultConfig)); setEnabled(dir, false);
    assert.equal(status(dir).config.enabled, false); assert.deepEqual(await runOnce(dir), { disabled: true });
    assert.equal(fs.existsSync(path.join(dir, 'cycle.lock')), false);
    assert.equal(fs.readdirSync(dir).some(x => x.endsWith('.tmp')), false);
  } finally { fs.rmSync(dir, { recursive: true }); }
});
