import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { authorizeBlockedWork, observedBlockedWorkRecovery, hashIdentity, goalIdentity,
  eligibility, defaultConfig, runCycle } from './system-error-recovery.mjs';
import { pin, checkedJson } from '../state/rvm-fast-operations-20261007/operation-io.mjs';

const clone = value => structuredClone(value);
const initialId = 'po-observed-turn';
const running = (id = initialId, startedAt = 100) => ({ id, status: 'inProgress', startedAt, error: null });
const failed = (id = initialId, startedAt = 100, completedAt = 200) => ({
  id, status: 'failed', startedAt, completedAt,
  error: { message: 'Selected model is at capacity.', codexErrorInfo: 'serverOverloaded' },
});
const task = () => ({ id: 'task', cwd: 'C:/retained/work', model: 'gpt-6.1-sol',
  modelProvider: 'openai', reasoningEffort: 'high', agentRole: 'owner',
  canAcceptDirectInput: true, parentThreadId: null, status: { type: 'active' } });
const blocked = () => ({ status: 'blocked', objective: 'Continue the original authorized work',
  tokenBudget: 123456, tokensUsed: 500, timeUsedSeconds: 8, createdAt: 50, updatedAt: 80 });
const mutationMethods = new Set(['thread/resume', 'thread/goal/set', 'turn/start', 'turn/steer']);

function memoryStore() {
  const records = new Map(), updates = [], savedStates = [];
  return { records, updates, savedStates, state: null, exists: key => records.has(key),
    recoveryRecords: () => [...records.values()].map(clone),
    existingEpisode: (id, turn) => [...records.values()].some(r => r.threadId === id && r.failedTurnId === turn),
    create(key, value) { assert.equal(records.has(key), false); records.set(key, clone(value)); updates.push(value.phase); },
    update(key, value) { records.set(key, clone(value)); updates.push(value.phase); },
    saveState(state) { this.state = clone(state); savedStates.push(clone(state)); }, allowed: () => true };
}

function fixture(t, { snapshotChange, permitChange } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-blocked-work-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const snapshot = { thread: task(), turns: [running()], goal: blocked() };
  const permit = { schemaVersion: 1, kind: 'po-directed-blocked-work',
    authorizingThreadId: 'po-authorizing-task', targetThreadId: snapshot.thread.id,
    initialTurnId: initialId, goalIdentity: goalIdentity(snapshot.goal),
    goalUpdatedAt: snapshot.goal.updatedAt, identityHash: hashIdentity(snapshot.thread) };
  snapshotChange?.(snapshot); permitChange?.(permit);
  const file = path.join(directory, 'permit.json');
  fs.writeFileSync(file, JSON.stringify(permit) + '\n');
  const authorizationPin = pin(file);
  assert.deepEqual(checkedJson(authorizationPin), permit);
  return { snapshot, permit, authorizationPin, file };
}

function clientFor(record, { receipt = 'typed', readback = 'visible', startError, resumeError, onRead } = {}) {
  const calls = [];
  let starts = 0, reads = 0, readFailure = false;
  return { record, calls,
    setReadFailure(value) { readFailure = value; },
    async call(method, params) {
      calls.push({ method, params: clone(params) });
      if (method === 'thread/list') return { data: [{ id: record.thread.id }], nextCursor: null };
      if (method === 'thread/loaded/list') return { data: [] };
      if (method === 'account/rateLimits/read') return { ordinaryUsageAllowed: true,
        rateLimits: { primary: { usedPercent: 20 }, secondary: null, spendControlReached: false } };
      assert.equal(params.threadId, record.thread.id);
      if (method === 'thread/read') {
        onRead?.(record, reads++);
        if (readFailure || (starts && readback === 'unavailable')) throw new Error('Transient read unavailable');
        return { thread: clone(record.thread) };
      }
      if (method === 'thread/turns/list') return { data: clone(record.turns) };
      if (method === 'thread/goal/get') return { goal: clone(record.goal) };
      if (method === 'thread/resume') {
        if (resumeError) throw resumeError;
        return { thread: clone(record.thread) };
      }
      if (method === 'thread/goal/set') throw new Error('Blocked-work continuation must never mutate goal status');
      if (method === 'turn/start') {
        if (startError) throw startError;
        const accepted = running('automatic-successor-' + ++starts, starts === 1 ? 210 : 270);
        if (readback !== 'invisible') {
          record.turns = [accepted, ...record.turns]; record.thread.status = { type: 'active' };
        }
        if (receipt === 'missing-id') return { turn: {} };
        return { turn: receipt === 'typed' ? clone(accepted) : { id: accepted.id } };
      }
      throw new Error('Unexpected RPC ' + method);
    } };
}

function terminal(record, id = initialId, startedAt = 100, completedAt = 200) {
  record.thread.status = { type: 'idle' }; record.turns = [failed(id, startedAt, completedAt)];
}
function authorizedState(snapshot, authorizationPin) {
  return { threads: { task: authorizeBlockedWork(snapshot, authorizationPin, 150000) } };
}
const mutations = client => client.calls.filter(call => mutationMethods.has(call.method));

test('PO permit admits only its exact confirmed running blocked-work snapshot', t => {
  const { snapshot, authorizationPin } = fixture(t);
  const entry = authorizeBlockedWork(snapshot, authorizationPin, 150000);
  assert.deepEqual(entry.blockedWorkObservation, { schemaVersion: 1, authorizationPin, initialTurnId: initialId,
    goalIdentity: goalIdentity(snapshot.goal), goalUpdatedAt: 80,
    identityHash: hashIdentity(snapshot.thread), turnId: initialId, turnStatus: 'inProgress', observedAt: 150000 });
  assert.equal(entry.latestTurnId, initialId); assert.equal(entry.latestTurnStatus, 'inProgress');
  assert.equal(entry.goalStatus, 'blocked');
});

test('permit admission rejects missing confirmation, protected owners and stale or mismatched authorization', t => {
  const changes = [
    ['direct input unknown', s => s.thread.canAcceptDirectInput = null],
    ['archived', s => s.thread.archived = true],
    ['native child', s => { s.thread.parentThreadId = 'parent'; s.thread.source = { subAgent: { thread_spawn: { parent_thread_id: 'parent' } } }; }],
    ['invalid parent', s => s.thread.parentThreadId = s.thread.id],
    ['latest failed', s => s.turns = [failed()]],
    ['superseded observed turn', s => s.turns = [running('newer-turn'), ...s.turns]],
    ['paused', s => s.goal.status = 'paused'],
    ['active goal', s => s.goal.status = 'active'],
    ['completed goal', s => s.goal.status = 'complete'],
    ['exhausted budget', s => s.goal.tokensUsed = s.goal.tokenBudget],
    ['unknown usage', s => delete s.goal.tokensUsed],
    ['nonfinite goal updatedAt', s => s.goal.updatedAt = null],
    ['changed goal', s => s.goal.objective = 'Different work'],
    ['changed updatedAt', s => s.goal.updatedAt++],
    ['changed settings identity', s => s.thread.reasoningEffort = 'low'],
    ['missing owner identity', s => delete s.thread.cwd],
  ];
  for (const [label, snapshotChange] of changes) {
    const f = fixture(t, { snapshotChange });
    assert.throws(() => authorizeBlockedWork(f.snapshot, f.authorizationPin, 150000), undefined, label);
  }
  for (const [label, permitChange] of [
    ['wrong version', p => p.schemaVersion = 2], ['wrong kind', p => p.kind = 'inferred'],
    ['no authorizer', p => p.authorizingThreadId = ''], ['wrong target', p => p.targetThreadId = 'other'],
    ['wrong observed turn', p => p.initialTurnId = 'old'], ['wrong goal', p => p.goalIdentity = 'f'.repeat(64)],
    ['wrong updatedAt', p => p.goalUpdatedAt++], ['wrong settings', p => p.identityHash = 'f'.repeat(64)],
  ]) {
    const f = fixture(t, { permitChange });
    assert.throws(() => authorizeBlockedWork(f.snapshot, f.authorizationPin, 150000), undefined, label);
  }
  const f = fixture(t);
  assert.throws(() => authorizeBlockedWork(f.snapshot, f.authorizationPin, 99000));
  assert.throws(() => authorizeBlockedWork(f.snapshot, f.authorizationPin, NaN));
  fs.appendFileSync(f.file, ' ');
  assert.throws(() => authorizeBlockedWork(f.snapshot, f.authorizationPin, 150000));
});

test('an initial blocked failure without explicit observed permit stays untouched', async t => {
  const f = fixture(t); terminal(f.snapshot);
  const client = clientFor(f.snapshot), store = memoryStore();
  const result = await runCycle(client, defaultConfig, { threads: {} }, store, () => 210000);
  assert.equal(result.resumed, 0); assert.equal(result.results[0].action, 'blocked-cause-unproven');
  assert.equal(mutations(client).length, 0); assert.equal(store.records.size, 0);
});

test('exact typed failure recovers blocked work and the fast successor failure retains goal, counters and settings', async t => {
  const f = fixture(t), state = authorizedState(f.snapshot, f.authorizationPin), store = memoryStore();
  const originalGoal = clone(f.snapshot.goal); terminal(f.snapshot);
  assert.equal(observedBlockedWorkRecovery(f.snapshot.thread, f.snapshot.turns, f.snapshot.goal, state.threads.task), true);
  assert.equal(eligibility(f.snapshot.thread, f.snapshot.turns, f.snapshot.goal, [], state.threads.task), 'eligible');
  const client = clientFor(f.snapshot);
  const first = await runCycle(client, defaultConfig, state, store, () => 210000);
  assert.equal(first.resumed, 1); assert.equal(first.results[0].action, 'accepted');
  assert.deepEqual(f.snapshot.goal, originalGoal);
  assert.equal(state.threads.task.blockedWorkObservation.turnId, 'automatic-successor-1');
  assert.equal(state.threads.task.blockedWorkObservation.turnStatus, 'inProgress');
  assert.equal(state.threads.task.count, 1); assert.equal(state.threads.task.nextEligibleAt, 270000);
  terminal(f.snapshot, 'automatic-successor-1', 210, 248);
  const early = await runCycle(client, defaultConfig, state, store, () => 248000);
  assert.equal(early.results[0].action, 'backoff'); assert.equal(store.records.size, 1);
  assert.equal(state.threads.task.blockedWorkObservation.turnId, 'automatic-successor-1');
  const second = await runCycle(client, defaultConfig, state, store, () => 270000);
  assert.equal(second.resumed, 1); assert.equal(store.records.size, 2);
  assert.equal(state.threads.task.count, 2); assert.equal(state.threads.task.nextEligibleAt, 390000);
  assert.deepEqual(f.snapshot.goal, originalGoal);
  assert.equal(client.calls.some(c => c.method === 'thread/goal/set'), false);
  for (const call of client.calls.filter(c => c.method === 'turn/start')) {
    assert.deepEqual(Object.keys(call.params).sort(), ['clientUserMessageId', 'input', 'threadId']);
  }
  for (const call of client.calls.filter(c => c.method === 'thread/resume')) {
    assert.deepEqual(call.params, { threadId: 'task', excludeTurns: true });
  }
});

test('ID-only accepted receipt can follow a separately confirmed exact inProgress readback', async t => {
  const f = fixture(t), state = authorizedState(f.snapshot, f.authorizationPin); terminal(f.snapshot);
  const client = clientFor(f.snapshot, { receipt: 'id-only' });
  const result = await runCycle(client, defaultConfig, state, memoryStore(), () => 210000);
  assert.equal(result.resumed, 1); assert.equal(result.results[0].readback, 'verified');
  assert.equal(state.threads.task.blockedWorkObservation.turnId, 'automatic-successor-1');
});

test('accepted successor journal closes the crash gap before its running-state save and preserves backoff', async t => {
  const f = fixture(t), state = authorizedState(f.snapshot, f.authorizationPin), store = memoryStore(); terminal(f.snapshot);
  const client = clientFor(f.snapshot);
  assert.equal((await runCycle(client, defaultConfig, state, store, () => 210000)).resumed, 1);
  const acceptedRecord = [...store.records.values()][0];
  assert.equal(acceptedRecord.blockedWorkSuccessor.turnId, 'automatic-successor-1');
  assert.equal(acceptedRecord.blockedWorkSuccessor.initialTurnId, initialId);
  // This is an actual saved pre-ack state, not a synthetic reset of retry counters.
  const crashState = clone(store.savedStates.find(s => s.threads.task.count === 1
    && s.threads.task.blockedWorkObservation?.turnId === initialId));
  assert.ok(crashState); assert.equal(crashState.threads.task.nextEligibleAt, 270000);
  terminal(f.snapshot, 'automatic-successor-1', 210, 248);
  const early = await runCycle(client, defaultConfig, crashState, store, () => 248000);
  assert.equal(early.results[0].action, 'backoff'); assert.equal(store.records.size, 1);
  assert.equal(crashState.threads.task.blockedWorkObservation.turnId, 'automatic-successor-1');
  const later = await runCycle(client, defaultConfig, crashState, store, () => 270000);
  assert.equal(later.resumed, 1); assert.equal(store.records.size, 2);
  assert.equal(crashState.threads.task.count, 2); assert.equal(crashState.threads.task.nextEligibleAt, 390000);
  assert.equal(f.snapshot.goal.status, 'blocked');
});

test('successor journal cannot bridge UNKNOWN, another failed turn, or changed permit lineage', async t => {
  for (const [label, change] of [
    ['UNKNOWN episode', r => r.phase = 'unknown-no-resend'],
    ['different failed turn', r => r.failedTurnId = 'other-failed-turn'],
    ['wrong accepted ID', r => r.acceptedTurnId = 'other-successor'],
    ['different initial lineage', r => r.blockedWorkSuccessor.initialTurnId = 'other-initial-turn'],
    ['different permit pin', r => r.blockedWorkSuccessor.authorizationPin.sha256 = 'f'.repeat(64)],
    ['different goal cut', r => r.blockedWorkSuccessor.goalUpdatedAt++],
    ['different identity', r => r.blockedWorkSuccessor.identityHash = 'f'.repeat(64)],
    ['no running evidence', r => r.blockedWorkSuccessor.turnStatus = 'failed'],
  ]) {
    const f = fixture(t), state = authorizedState(f.snapshot, f.authorizationPin), store = memoryStore();
    const original = clone(state.threads.task.blockedWorkObservation);
    const record = { schemaVersion: 1, threadId: 'task', failedTurnId: initialId,
      phase: 'accepted', acceptedTurnId: 'automatic-successor-1', createdAt: new Date(210000).toISOString(),
      blockedWorkSuccessor: { ...clone(original), turnId: 'automatic-successor-1', observedAt: 210000 } };
    change(record); store.records.set('prior-recovery', record);
    terminal(f.snapshot, 'automatic-successor-1', 210, 248);
    const client = clientFor(f.snapshot);
    const result = await runCycle(client, defaultConfig, state, store, () => 270000);
    assert.equal(result.resumed, 0, label); assert.equal(mutations(client).length, 0, label);
    assert.equal(state.threads.task.blockedWorkObservation, undefined, label);
  }
});

test('typed running receipt follows its successor even if live readback is transiently unavailable', async t => {
  const f = fixture(t), state = authorizedState(f.snapshot, f.authorizationPin), store = memoryStore(); terminal(f.snapshot);
  const client = clientFor(f.snapshot, { readback: 'unavailable' });
  const first = await runCycle(client, defaultConfig, state, store, () => 210000);
  assert.equal(first.resumed, 1); assert.equal(first.results[0].readback, 'unavailable');
  assert.equal(state.threads.task.blockedWorkObservation.turnId, 'automatic-successor-1');
  terminal(f.snapshot, 'automatic-successor-1', 210, 248);
  assert.equal(eligibility(f.snapshot.thread, f.snapshot.turns, f.snapshot.goal, [], state.threads.task), 'eligible');
});

test('ID-only acknowledgement without visible inProgress never authorizes its successor', async t => {
  for (const readback of ['unavailable', 'invisible']) {
    const f = fixture(t), state = authorizedState(f.snapshot, f.authorizationPin), store = memoryStore(); terminal(f.snapshot);
    const client = clientFor(f.snapshot, { receipt: 'id-only', readback });
    const result = await runCycle(client, defaultConfig, state, store, () => 210000);
    assert.equal(result.resumed, 1);
    assert.notEqual(state.threads.task.blockedWorkObservation?.turnId, 'automatic-successor-1');
    terminal(f.snapshot, 'automatic-successor-1', 210, 248);
    assert.equal(observedBlockedWorkRecovery(f.snapshot.thread, f.snapshot.turns, f.snapshot.goal, state.threads.task), false);
    assert.equal(eligibility(f.snapshot.thread, f.snapshot.turns, f.snapshot.goal, [], state.threads.task), 'blocked-cause-unproven');
  }
});

test('transient snapshot read failure retains a valid permit without treating the read as task failure', async t => {
  const f = fixture(t), state = authorizedState(f.snapshot, f.authorizationPin), store = memoryStore(); terminal(f.snapshot);
  const before = clone(state.threads.task.blockedWorkObservation), client = clientFor(f.snapshot);
  client.setReadFailure(true);
  const failedRead = await runCycle(client, defaultConfig, state, store, () => 210000);
  assert.equal(failedRead.results[0].action, 'read-failed-no-mutation');
  assert.deepEqual(state.threads.task.blockedWorkObservation, before);
  assert.equal(mutations(client).length, 0); assert.equal(store.records.size, 0);
  client.setReadFailure(false);
  const recovered = await runCycle(client, defaultConfig, state, store, () => 211000);
  assert.equal(recovered.resumed, 1);
});

test('exact observed turn and finite temporal evidence are required, not error text or an older failed turn', t => {
  for (const [label, change] of [
    ['different turn', s => s.turns[0].id = 'unobserved'],
    ['completed', s => s.turns[0].status = 'completed'],
    ['interrupted', s => s.turns[0].status = 'interrupted'],
    ['untyped', s => delete s.turns[0].error.codexErrorInfo],
    ['not transient', s => s.turns[0].error.codexErrorInfo = 'badRequest'],
    ['server retrying', s => s.turns[0].error.willRetry = true],
    ['unknown completion time', s => delete s.turns[0].completedAt],
    ['failure predates observation', s => s.turns[0].completedAt = 149],
  ]) {
    const f = fixture(t), previous = authorizeBlockedWork(f.snapshot, f.authorizationPin, 150000);
    terminal(f.snapshot); change(f.snapshot);
    assert.equal(observedBlockedWorkRecovery(f.snapshot.thread, f.snapshot.turns, f.snapshot.goal, previous), false, label);
  }
});

test('goal, identity, protection and unrelated manual turn changes invalidate and clear the permit', async t => {
  for (const [label, change] of [
    ['objective', s => s.goal.objective = 'Different authorized work'],
    ['budget', s => s.goal.tokenBudget++],
    ['createdAt', s => s.goal.createdAt++],
    ['updatedAt', s => s.goal.updatedAt++],
    ['paused', s => s.goal.status = 'paused'],
    ['completed goal', s => s.goal.status = 'complete'],
    ['budget limited', s => s.goal.status = 'budgetLimited'],
    ['usage limited', s => s.goal.status = 'usageLimited'],
    ['exhausted', s => s.goal.tokensUsed = s.goal.tokenBudget],
    ['unknown usage', s => delete s.goal.tokensUsed],
    ['settings', s => s.thread.model = 'different-model'],
    ['completed turn', s => s.turns = [{ id: initialId, status: 'completed' }]],
    ['interrupted turn', s => s.turns = [{ id: initialId, status: 'interrupted' }]],
    ['manual running turn', s => { s.turns = [running('manual-new-turn', 210)]; s.thread.status = { type: 'active' }; }],
    ['manual failed turn', s => s.turns = [failed('manual-new-turn', 210, 248)]],
  ]) {
    const f = fixture(t), state = authorizedState(f.snapshot, f.authorizationPin); terminal(f.snapshot); change(f.snapshot);
    const client = clientFor(f.snapshot), store = memoryStore();
    const result = await runCycle(client, defaultConfig, state, store, () => 270000);
    assert.equal(result.resumed, 0, label); assert.equal(mutations(client).length, 0, label);
    assert.equal(state.threads.task.blockedWorkObservation, undefined, label);
    assert.equal(store.records.size, 0, label);
  }
});

test('tampered or missing pinned permit fails closed at recovery and clears stale authorization', async t => {
  for (const changeFile of [f => fs.appendFileSync(f.file, ' '), f => fs.unlinkSync(f.file)]) {
    const f = fixture(t), state = authorizedState(f.snapshot, f.authorizationPin); terminal(f.snapshot); changeFile(f);
    assert.equal(observedBlockedWorkRecovery(f.snapshot.thread, f.snapshot.turns, f.snapshot.goal, state.threads.task), false);
    const client = clientFor(f.snapshot), result = await runCycle(client, defaultConfig, state, memoryStore(), () => 210000);
    assert.equal(result.resumed, 0); assert.equal(mutations(client).length, 0);
    assert.equal(state.threads.task.blockedWorkObservation, undefined);
  }
});

test('UNKNOWN dispatch never resends the exact blocked-work episode and creates no running successor evidence', async t => {
  for (const option of [{ startError: new Error('Timed out after send') },
    { resumeError: new Error('Disconnected after send') }, { receipt: 'missing-id' }]) {
    const f = fixture(t), state = authorizedState(f.snapshot, f.authorizationPin), store = memoryStore(); terminal(f.snapshot);
    const client = clientFor(f.snapshot, option);
    const first = await runCycle(client, defaultConfig, state, store, () => 210000);
    assert.equal(first.results[0].action, 'unknown-no-resend');
    assert.notEqual(state.threads.task.blockedWorkObservation?.turnId, 'automatic-successor-1');
    const before = mutations(client).length;
    terminal(f.snapshot);
    await runCycle(client, defaultConfig, state, store, () => 900000);
    assert.equal(mutations(client).length, before); assert.equal(store.records.size, 1);
    assert.equal([...store.records.values()][0].phase, 'unknown-no-resend');
  }
});

test('explicit blocked-work permit keeps exclusion, stopped config, dry-run and exclusive episode protections', async t => {
  for (const mode of ['excluded', 'disabled', 'stopped', 'dry-run', 'claimed']) {
    const f = fixture(t), state = authorizedState(f.snapshot, f.authorizationPin), store = memoryStore(); terminal(f.snapshot);
    const config = { ...defaultConfig,
      ...(mode === 'excluded' ? { excludedThreadIds: ['task'] } : {}),
      ...(mode === 'disabled' ? { enabled: false } : {}) };
    if (mode === 'stopped') store.allowed = () => false;
    if (mode === 'claimed') store.records.set('legacy-claim', { threadId: 'task', failedTurnId: initialId, phase: 'unknown-no-resend' });
    const client = clientFor(f.snapshot);
    const result = await runCycle(client, config, state, store, () => 210000, mode === 'dry-run');
    assert.equal(result.resumed, 0, mode); assert.equal(mutations(client).length, 0, mode);
    assert.deepEqual(f.snapshot.goal, blocked(), mode);
  }
});
