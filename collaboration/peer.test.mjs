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
    if (method === 'thread/read') return { thread: { id: params.threadId, cwd: workspace, status: { type: this.active ? 'active' : 'idle' } } };
    if (method === 'thread/goal/get') return { goal: this.paused ? { status: 'paused' } : null };
    if (method === 'thread/turns/list') return { data: this.active ? [{ id: 'running-turn', status: 'inProgress' }] : [] };
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
  const result = await sendPeer({ client, runtime, request: { threadId: 'chosen', operationId: randomUUID() }, message: 'review authentication', record, persist() {}, routeFactory });
  assert.equal(result.turnId, 'new-turn');
  const mutations = client.calls.filter(([m]) => !['thread/read', 'thread/goal/get', 'thread/turns/list'].includes(m));
  assert.deepEqual(mutations, [['turn/start', { threadId: 'chosen', input: [{ type: 'text', text: 'review authentication', text_elements: [] }] }]]);
});
test('active task steers the observed exact turn', async () => {
  const client = new Client({ active: true });
  await sendPeer({ client, runtime, request: { threadId: 'chosen', operationId: randomUUID() }, message: 'check rollback', record: {}, persist() {}, routeFactory });
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
  const client = { call: async method => method === 'thread/turns/list'
    ? { data: [{ id: 'turn', status: 'completed' }] }
    : { data: [{ turnId: 'turn', item: { type: 'agentMessage', phase: final ? 'final_answer' : 'commentary', text: final ? '' : 'Looking into it' } }] } };
  assert.equal((await turnAnswer(client, 'chosen', 'turn')).answerAvailable, false);
  final = true;
  const result = await turnAnswer(client, 'chosen', 'turn');
  assert.equal(result.answerAvailable, true); assert.equal(result.answer, '');
});
test('exact old turns are found through pagination', async () => {
  const client = new Client();
  client.call = async (method, params) => {
    if (method === 'thread/read') return { thread: { id: 'chosen' } };
    if (method === 'thread/goal/get') return { goal: null };
    return params.cursor ? { data: [{ id: 'saved', status: 'failed', error: { message: 'capacity' } }] } : { data: [{ id: 'newer' }], nextCursor: 'older' };
  };
  assert.equal((await inspectPeer(client, 'chosen', 'saved')).turn.error.message, 'capacity');
});
test('a newly created empty thread receives its first message without a resume or a second creation', async () => {
  const client = new Client();
  const original = client.call.bind(client);
  client.call = async (method, params) => {
    if (method === 'thread/turns/list') throw new Error('thread is not materialized yet; thread/turns/list is unavailable before first user message');
    return original(method, params);
  };
  const result = await sendPeer({ client, runtime, request: { create: true, workspace, mode: 'review', operationId: randomUUID() }, message: 'first message', record: {}, persist() {}, routeFactory });
  assert.equal(result.threadId, 'new-peer');
  assert.equal(client.calls.filter(([method]) => method === 'thread/start').length, 1);
  assert.deepEqual(client.calls.at(-1), ['turn/start', { threadId: 'new-peer', input: [{ type: 'text', text: 'first message', text_elements: [] }] }]);
});
test('disconnect while waiting is an error, not completion', async () => {
  const client = new Client({ active: true });
  const waiting = waitPeer(client, 'chosen', 'running-turn');
  setImmediate(() => client.emit('disconnected', {}));
  await assert.rejects(waiting, /disconnected/);
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
    if (method === 'thread/turns/list' && started) {
      if (unpublished) { unpublished = false; throw new Error('failed to read session metadata: rollout at local/session.jsonl is empty'); }
      return { data: [{ id: 'fast-turn', status: 'completed' }] };
    }
    if (method === 'thread/items/list') return { data: [{ turnId: 'fast-turn', item: { type: 'agentMessage', phase: 'final_answer', text: 'independent fixture answer' } }] };
    return original(method, params);
  };
  await sendPeer({ client, runtime, request: { threadId: 'chosen', operationId: randomUUID() }, message: 'bounded task', record: {}, persist() {}, routeFactory });
  const result = await waitPeer(client, 'chosen', 'fast-turn');
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
    assert.equal(first.phase, fails ? 'unknown-do-not-resend' : 'completed');
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
