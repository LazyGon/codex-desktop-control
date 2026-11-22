import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { sendPeer, inspectPeer, waitPeer, turnAnswer } from './codex-peer.mjs';
import { runRequest } from './peer.mjs';
import { claudeArguments } from './claude-peer.mjs';

const workspace = process.cwd();
const runtime = { statePath: new URL('../launcher/state/current.json', import.meta.url), endpoint: 'ws://127.0.0.1:8798', serverProcessId: 123 };
class Client extends EventEmitter {
  constructor({ active = false, paused = false } = {}) { super(); this.connected = true; this.active = active; this.paused = paused; this.calls = []; }
  async call(method, params) {
    this.calls.push([method, params]);
    if (method === 'thread/read') return { thread: { id: params.threadId, cwd: workspace, status: { type: this.active ? 'active' : 'idle' }, turns: params.includeTurns ? (params.threadId === 'new-peer' ? [] : this.active ? [{ id: 'running-turn', status: 'inProgress' }] : [{ id: 'old-turn', status: 'completed' }]) : [] } };
    if (method === 'thread/goal/get') return { goal: this.paused ? { status: 'paused' } : null };
    if (method === 'thread/start') return { thread: { id: 'new-peer' } };
    if (method === 'turn/start') return { turn: { id: 'new-turn' } };
    if (method === 'turn/steer') return { turnId: 'running-turn' };
    throw new Error('Unexpected request: ' + method);
  }
  close() { this.connected = false; }
}
const routeFactory = () => ({ verifyRuntime() {}, async prepareDesktopThread() { throw new Error('A loaded task must not be reloaded.'); } });
test('idle task starts once without overriding its settings or resuming its owner', async () => {
  const client = new Client(), record = {};
  const result = await sendPeer({ client, runtime, request: { threadId: 'chosen', model: 'gpt-6-luna', effort: 'low', operationId: randomUUID() }, message: 'review authentication', record, persist() {}, routeFactory });
  assert.equal(result.turnId, 'new-turn');
  const mutations = client.calls.filter(([m]) => !['thread/read', 'thread/goal/get', 'thread/turns/list'].includes(m));
  assert.deepEqual(mutations, [['turn/start', { threadId: 'chosen', input: [{ type: 'text', text: 'review authentication', text_elements: [] }] }]]);
});
test('active task steers the observed exact turn', async () => {
  const client = new Client({ active: true });
  await sendPeer({ client, runtime, request: { threadId: 'chosen', create: true, model: 'gpt-6-luna', effort: 'low', operationId: randomUUID() }, message: 'check rollback', record: {}, persist() {}, routeFactory });
  assert.deepEqual(client.calls.at(-1), ['turn/steer', { threadId: 'chosen', expectedTurnId: 'running-turn', input: [{ type: 'text', text: 'check rollback', text_elements: [] }] }]);
});
test('a paused goal prevents delivery', async () => {
  const client = new Client({ paused: true });
  await assert.rejects(sendPeer({ client, runtime, request: { threadId: 'paused', operationId: randomUUID() }, message: 'work', record: {}, persist() {}, routeFactory }), /paused/);
  assert.equal(client.calls.some(([m]) => m === 'turn/start' || m === 'turn/steer'), false);
});
test('a pause during Desktop loading prevents the eventual mutation', async () => {
  const client = new Client();
  let unloaded = true;
  const original = client.call.bind(client);
  client.call = async (method, params) => {
    const result = await original(method, params);
    if (method === 'thread/read' && unloaded) result.thread.status.type = 'notLoaded';
    return result;
  };
  const routeFactory = () => ({ verifyRuntime() {}, async prepareDesktopThread() { unloaded = false; client.paused = true; } });
  await assert.rejects(sendPeer({ client, runtime, request: { threadId: 'chosen', operationId: randomUUID() }, message: 'work', record: {}, persist() {}, routeFactory }), /paused/);
  assert.equal(client.calls.some(([method]) => method === 'turn/start' || method === 'turn/steer'), false);
});
test('commentary is not a final review; an explicitly empty final is still available', async () => {
  let final = false;
  const client = { call: async () => ({ thread: { turns: [{ id: 'turn', status: 'completed', items: [
    { type: 'agentMessage', phase: final ? 'final_answer' : 'commentary', text: final ? '' : 'Looking into it' },
  ] }] } }) };
  assert.equal((await turnAnswer(client, 'chosen', 'turn')).answerAvailable, false);
  final = true;
  const result = await turnAnswer(client, 'chosen', 'turn');
  assert.equal(result.answerAvailable, true); assert.equal(result.answer, '');
});
test('exact old turns are selected instead of the current running turn', async () => {
  const client = new Client();
  client.call = async method => method === 'thread/goal/get' ? { goal: null } : { thread: { id: 'chosen', turns: [
    { id: 'saved', status: 'failed', error: { message: 'capacity' } }, { id: 'newer', status: 'inProgress' },
  ] } };
  assert.equal((await inspectPeer(client, 'chosen', 'saved')).turn.error.message, 'capacity');
});
test('a newly created empty thread receives its first message without a resume or a second creation', async () => {
  const client = new Client();
  const original = client.call.bind(client);
  client.call = async (method, params) => {
    if (method === 'thread/read' && params.includeTurns) throw new Error('thread is not materialized yet; thread/turns/list is unavailable before first user message');
    return original(method, params);
  };
  const result = await sendPeer({ client, runtime, request: { create: true, workspace, mode: 'review', operationId: randomUUID() }, message: 'first message', record: {}, persist() {}, routeFactory });
  assert.equal(result.threadId, 'new-peer');
  assert.equal(client.calls.filter(([method]) => method === 'thread/start').length, 1);
  assert.deepEqual(client.calls.find(([method]) => method === 'thread/start'), ['thread/start', { cwd: workspace, model: 'gpt-6.1-sol', sandbox: 'read-only' }]);
  assert.deepEqual(client.calls.at(-1), ['turn/start', { threadId: 'new-peer', input: [{ type: 'text', text: 'first message', text_elements: [] }] }]);
});

test('new peers accept the allowed models and efforts only at creation', async () => {
  for (const model of ['gpt-6-luna', 'gpt-6-sol', 'gpt-6.1-sol', 'gpt-6.1-terra']) {
    for (const effort of ['low', 'medium', 'high', 'xhigh']) {
      const client = new Client();
      await sendPeer({ client, runtime, request: { create: true, workspace, model, effort, mode: 'review', operationId: randomUUID() }, message: 'bounded review', record: {}, persist() {}, routeFactory });
      assert.deepEqual(client.calls.find(([method]) => method === 'thread/start'), ['thread/start', {
        cwd: workspace, model, config: { model_reasoning_effort: effort }, sandbox: 'read-only',
      }]);
      assert.deepEqual(client.calls.at(-1), ['turn/start', { threadId: 'new-peer', input: [{ type: 'text', text: 'bounded review', text_elements: [] }] }]);
    }
  }
});

test('model and effort can each be omitted independently without changing other defaults', async () => {
  for (const [settings, expected] of [
    [{ model: 'gpt-6-luna' }, { model: 'gpt-6-luna' }],
    [{ effort: 'medium' }, { model: 'gpt-6.1-sol', config: { model_reasoning_effort: 'medium' } }],
  ]) {
    const client = new Client();
    await sendPeer({ client, runtime, request: { create: true, workspace, mode: 'implement', ...settings, operationId: randomUUID() }, message: 'bounded implementation', record: {}, persist() {}, routeFactory });
    assert.deepEqual(client.calls.find(([method]) => method === 'thread/start'), ['thread/start', { cwd: workspace, ...expected }]);
  }
});

test('invalid peer settings are rejected before dispatch and retained in the operation journal', async t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'peer-settings-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const messageFile = path.join(temporary, 'input.txt'); fs.writeFileSync(messageFile, 'bounded task');
  for (const [key, values] of [
    ['model', ['gpt-6.2-sol', 'gpt-6-astra', 'gpt-6.1-invented', '', null, 1, {}]],
    ['effort', ['max', 'ultra', 'minimal', 'HIGH', '', null, 1, {}]],
  ]) {
    for (const value of values) {
      const client = new Client(), operationId = randomUUID();
      const request = { peer: 'codex', create: true, workspace, messageFile, operationId, [key]: value };
      const result = await runRequest(request, { stateRoot: temporary, connect: async () => ({ client, runtime }) });
      assert.equal(result.phase, 'not-delivered');
      assert.match(result.error, new RegExp(key + ' must be one of'));
      assert.deepEqual(client.calls, []);
      const saved = JSON.parse(fs.readFileSync(path.join(temporary, operationId, 'result.json'), 'utf8'));
      assert.equal(saved.phase, 'not-delivered'); assert.equal(saved.error, result.error);
      assert.deepEqual(saved.requestedSettings, { [key]: value });
    }
  }
});
test('disconnect, missing projection and read errors remain pending until the exact turn ends', async () => {
  const client = new Client({ active: true });
  let reads = 0;
  client.call = async () => {
    reads++;
    if (reads === 1) { client.emit('disconnected'); throw new Error('disconnected'); }
    if (reads === 2) return { thread: { turns: [] } };
    return { thread: { turns: [{ id: 'running-turn', status: reads < 5 ? 'inProgress' : 'completed' }] } };
  };
  const phases = [], warnings = [];
  const result = await waitPeer(client, 'chosen', 'running-turn', { pollIntervalMs: 5, onUpdate: r => {
    phases.push(r.status); if (r.waiterWarning) warnings.push(r.waiterWarning);
  } });
  assert.equal(result.status, 'completed');
  assert.deepEqual(phases, ['inProgress', 'inProgress', 'inProgress', 'inProgress', 'completed']);
  assert.match(warnings[0], /disconnected/); assert.match(warnings[1], /not projected/);
});
test('completion before dispatch returns and temporarily unpublished metadata still yield the exact answer', async () => {
  const client = new Client();
  const original = client.call.bind(client);
  let started = false, unpublished = true;
  client.call = async (method, params) => {
    if (method === 'turn/start') {
      started = true;
      client.emit('notification', { method: 'turn/completed', params: { threadId: 'chosen', turn: { id: 'fast-turn', status: 'completed' } } });
      return { turn: { id: 'fast-turn' } };
    }
    if (method === 'thread/read' && params.includeTurns && started) {
      if (unpublished) { unpublished = false; throw new Error('failed to read session metadata: rollout at local/session.jsonl is empty'); }
      return { thread: { turns: [{ id: 'fast-turn', status: 'completed', items: [{ type: 'agentMessage', phase: 'final_answer', text: 'independent fixture answer' }] }] } };
    }
    return original(method, params);
  };
  await sendPeer({ client, runtime, request: { threadId: 'chosen', operationId: randomUUID() }, message: 'bounded task', record: {}, persist() {}, routeFactory });
  const result = await waitPeer(client, 'chosen', 'fast-turn', { pollIntervalMs: 5 });
  assert.equal(result.status, 'completed'); assert.equal(result.answer, 'independent fixture answer');
});
test('reusing an operation id never repeats either a successful or uncertain Claude request', async t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'peer-contract-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const messageFile = path.join(temporary, 'input.txt'); fs.writeFileSync(messageFile, 'Review the independent input.');
  for (const fails of [false, true]) {
    let calls = 0;
    const request = { peer: 'claude', workspace, operationId: randomUUID(), messageFile };
    const dependencies = { stateRoot: temporary, claude: async () => { calls++; if (fails) throw new Error('connection lost'); return { sessionId: 'saved-session', answer: 'finding' }; } };
    const first = await runRequest(request, dependencies);
    const second = await runRequest(request, dependencies);
    assert.equal(first.phase, fails ? 'unknown' : 'completed');
    assert.equal(second.existingOperation, true); assert.equal(calls, 1);
  }
});
test('Claude review cannot request edit or shell tools and resumes an exact session', () => {
  assert.deepEqual(claudeArguments({ mode: 'review', sessionId: 'prior' }), ['-p', '--output-format', 'json', '--resume', 'prior', '--permission-mode', 'plan', '--tools', 'Read,Glob,Grep']);
});
test('known Claude failure keeps its continuation identity', async t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'peer-failure-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const messageFile = path.join(temporary, 'input.txt'); fs.writeFileSync(messageFile, 'bounded task');
  const result = await runRequest({ peer: 'claude', workspace, operationId: randomUUID(), messageFile }, {
    stateRoot: temporary, claude: async () => { throw Object.assign(new Error('interrupted'), { knownFailure: true, peerResult: { sessionId: 'retain-me', exitCode: 1 } }); },
  });
  assert.equal(result.phase, 'failed'); assert.equal(result.sessionId, 'retain-me');
});

for (const status of ['completed', 'failed', 'interrupted']) {
  test('unsubscribed follow-up reaches ' + status + ' without a completion event or resend', async () => {
    const client = new Client();
    const original = client.call.bind(client);
    let started = false, terminal = false;
    client.call = async (method, params) => {
      if (method === 'turn/start') started = true;
      if (method === 'thread/read' && params.includeTurns && terminal) {
        return { thread: { turns: [
          { id: 'new-turn', status, error: status === 'failed' ? { message: 'capacity' } : null, items: [{ type: 'agentMessage', phase: 'final_answer', text: 'saved outcome' }] },
          { id: 'later-turn', status: 'inProgress' },
        ] } };
      }
      if (method === 'thread/read' && params.includeTurns && started) {
        terminal = true;
        return { thread: { turns: [{ id: 'new-turn', status: 'inProgress' }] } };
      }
      return original(method, params);
    };
    await sendPeer({ client, runtime, request: { threadId: 'chosen', operationId: randomUUID() }, message: 'follow-up', record: {}, persist() {}, routeFactory });
    const result = await waitPeer(client, 'chosen', 'new-turn', { pollIntervalMs: 5 });
    assert.equal(result.status, status);
    assert.equal(result.answer, 'saved outcome');
    assert.equal(client.calls.filter(([m]) => m === 'turn/start').length, 1);
    assert.equal(client.listenerCount('notification'), 0);
    assert.equal(client.listenerCount('disconnected'), 0);
  });
}

test('status recovers a missed completion into durable result without sending work', async t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'peer-recovery-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const operationId = randomUUID(), directory = path.join(temporary, operationId);
  fs.mkdirSync(directory);
  const file = path.join(directory, 'result.json');
  fs.writeFileSync(file, JSON.stringify({ operationId, peer: 'codex', accepted: true, phase: 'accepted', threadId: 'chosen', turnId: 'finished' }));
  const client = new Client();
  client.call = async method => {
    if (method === 'thread/read') return { thread: { turns: [{ id: 'finished', status: 'completed', items: [{ type: 'agentMessage', phase: 'final_answer', text: 'actual outcome' }] }] } };
    throw new Error('No mutation permitted: ' + method);
  };
  const result = await runRequest({ peer: 'codex', action: 'status', operationId }, { stateRoot: temporary, connect: async () => ({ client }) });
  assert.equal(result.phase, 'completed');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).answer, 'actual outcome');
});


test('unsupported history is detected once and exact lifecycle comes from the rollout', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'peer-rollout-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'rollout.jsonl');
  fs.writeFileSync(file, [
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'saved' } },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'saved', last_agent_message: 'saved answer' } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'newer' } },
  ].map(x => JSON.stringify(x) + '\n').join(''));
  const client = new Client(); let attempts = 0;
  client.call = async (method, params) => {
    if (method === 'thread/goal/get') return { goal: null };
    assert.equal(method, 'thread/read');
    if (params.includeTurns) { attempts++; throw new Error('thread/read: {"code":-32601,"message":"list_turns is not supported yet"}'); }
    return { thread: { id: 'chosen', path: file } };
  };
  assert.equal((await inspectPeer(client, 'chosen', 'saved')).turn.status, 'completed');
  assert.equal((await inspectPeer(client, 'chosen')).turn.id, 'newer');
  assert.equal((await inspectPeer(client, 'chosen')).turn.status, 'inProgress');
  assert.equal(attempts, 1);
});

test('Desktop timeout is not-delivered; an explicit AppServer fallback delivers once', async t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'peer-fallback-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const messageFile = path.join(temporary, 'input.txt'); fs.writeFileSync(messageFile, 'bounded input');
  const client = new Client(); let unloaded = true, sent = false;
  const original = client.call.bind(client);
  client.call = async (method, params) => {
    if (method === 'thread/resume') { assert.deepEqual(params, { threadId: 'chosen', excludeTurns: true }); unloaded = false; return {}; }
    const result = await original(method, params);
    if (method === 'thread/read') {
      result.thread.status.type = unloaded ? 'notLoaded' : 'idle';
      if (sent && params.includeTurns) result.thread.turns = [{ id: 'new-turn', status: 'completed', items: [{ type: 'agentMessage', phase: 'final_answer', text: 'fallback answer' }] }];
    }
    if (method === 'turn/start') sent = true;
    return result;
  };
  const request = { peer: 'codex', threadId: 'chosen', messageFile, operationId: randomUUID() };
  const deps = { stateRoot: temporary, connect: async () => ({ client, runtime }), routeFactory: () => ({ verifyRuntime() {}, prepareDesktopThread: async () => { throw new Error('Desktop load timed out. No completion was sent.'); } }) };
  const unsent = await runRequest(request, deps);
  assert.equal(unsent.phase, 'not-delivered'); assert.equal(sent, false);
  assert.equal(unsent.deliveryEvidence.turnMutationAttempted, false);
  assert.deepEqual(unsent.fallback, { deliveryRoute: 'appserver', threadId: 'chosen', safeToResend: true });
  client.connected = true;
  const result = await runRequest({ ...request, operationId: randomUUID(), deliveryRoute: 'appserver' }, deps);
  assert.equal(result.phase, 'completed'); assert.equal(result.answer, 'fallback answer');
  assert.equal(client.calls.filter(([method]) => method === 'turn/start').length, 1);
});

test('uncertain turn mutation remains unknown and reusing its operation never resends', async t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'peer-unknown-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const messageFile = path.join(temporary, 'input.txt'); fs.writeFileSync(messageFile, 'bounded input');
  const client = new Client(); const original = client.call.bind(client); let sends = 0;
  client.call = async (method, params) => {
    if (method === 'turn/start') { sends++; throw new Error('connection lost after send'); }
    return original(method, params);
  };
  const request = { peer: 'codex', threadId: 'chosen', messageFile, operationId: randomUUID() };
  const deps = { stateRoot: temporary, connect: async () => ({ client, runtime }), routeFactory };
  const result = await runRequest(request, deps);
  assert.equal(result.phase, 'unknown'); assert.equal(result.fallback, undefined);
  assert.equal((await runRequest(request, deps)).existingOperation, true); assert.equal(sends, 1);
});


test('the terminal observation is returned without a second lagging projection read', async () => {
  const client = new Client(); let reads = 0;
  client.call = async () => ({ thread: { turns: [{ id: 'target', status: ++reads === 1 ? 'completed' : 'inProgress', items: [
    { type: 'agentMessage', phase: 'final_answer', text: 'terminal answer' },
  ] }] } });
  const result = await waitPeer(client, 'chosen', 'target');
  assert.equal(result.status, 'completed'); assert.equal(result.answer, 'terminal answer');
  assert.equal(reads, 1);
});

test('a server-rejected input is safe to resend, unlike a lost mutation receipt', async t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'peer-rejected-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const messageFile = path.join(temporary, 'input.txt'); fs.writeFileSync(messageFile, 'bounded input');
  const client = new Client(), original = client.call.bind(client);
  client.call = async (method, params) => {
    if (method === 'turn/start') throw new Error('turn/start: {"code":-32600,"message":"thread not found: chosen"}');
    return original(method, params);
  };
  const result = await runRequest({ peer: 'codex', threadId: 'chosen', messageFile, operationId: randomUUID() }, {
    stateRoot: temporary, connect: async () => ({ client, runtime }), routeFactory,
  });
  assert.equal(result.phase, 'not-delivered'); assert.equal(result.deliveryEvidence.inputRejected, true);
  assert.equal(result.fallback.safeToResend, true);
});
