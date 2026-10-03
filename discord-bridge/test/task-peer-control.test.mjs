import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { TaskListFederation } from '../src/task-list-federation.mjs';
import { executeTaskOperation, validateTaskOperation } from '../src/task-peer-control.mjs';

const token = 'fake-test-bot-token';
const taskId = '01234567-89ab-cdef-0123-456789abcdef';

async function freePort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function controlPair(context, handler) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-task-peer-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const portA = await freePort();
  const portB = await freePort();
  const common = { multiPcEnabled: true, applicationId: 'app', guildId: 'guild',
    authorizedUserIds: ['user'], taskListListenHost: '127.0.0.1',
    taskListPeerTimeoutMs: 1000, taskControlEnabled: true, taskControlTimeoutMs: 1000 };
  const configA = { ...common, instanceId: 'A', taskListListenPort: portA,
    taskListPeers: [{ instanceId: 'B', url: `http://127.0.0.1:${portB}`, allowTaskControl: true }] };
  const configB = { ...common, instanceId: 'B', taskListListenPort: portB,
    taskListPeers: [{ instanceId: 'A', url: `http://127.0.0.1:${portA}`, allowTaskControl: true }] };
  const createB = () => new TaskListFederation({ config: configB, token,
    getLocalTasks: async () => [{ id: taskId, name: 'Task', updatedAt: 1 }],
    executeLocalOperation: handler, operationJournalPath: path.join(root, 'journal.jsonl') });
  const a = new TaskListFederation({ config: configA, token,
    getLocalTasks: async () => [], executeLocalOperation: async () => null,
    operationJournalPath: path.join(root, 'a-journal.jsonl') });
  let b = createB();
  context.after(async () => { await a.stop(); await b.stop(); });
  await a.start(); await b.start();
  return { a, b: () => b, restartB: async () => { await b.stop(); b = createB(); await b.start(); },
    journalPath: path.join(root, 'journal.jsonl'), configB };
}

test('peer control has a closed action and parameter schema', () => {
  assert.deepEqual(validateTaskOperation({ action: 'send', threadId: taskId, prompt: 'hello' }),
    { action: 'send', threadId: taskId, prompt: 'hello' });
  for (const operation of [
    { action: 'rpc', method: 'command/exec' },
    { action: 'send', threadId: 'latest', prompt: 'hello' },
    { action: 'send', threadId: taskId, prompt: '' },
    { action: 'interrupt', threadId: taskId, command: ['cmd.exe'] },
    { action: 'create', projectId: '../private', prompt: 'hello' },
  ]) assert.throws(() => validateTaskOperation(operation));
});

test('owning PC verifies visible task and project before local AppServer effects', async () => {
  const calls = [];
  const codex = { connected: true,
    threadMetadata: async (id) => ({ thread: { id } }),
    readThreadWindow: async () => ({ thread: { name: 'Task', turns: [{ id: 'turn', status: 'completed',
      items: [{ type: 'agentMessage', text: 'done', secret: 'not exposed' }] }] } }),
    startThread: async (cwd) => { calls.push(['startThread', cwd]); return { thread: { id: taskId } }; },
    send: async (id, prompt) => { calls.push(['send', id, prompt]); return { mode: 'send', turnId: 'turn' }; },
    interrupt: async (id) => { calls.push(['interrupt', id]); return { threadId: id, turnId: 'turn' }; },
    activeTurn: async () => null,
    archiveThread: async (id) => { calls.push(['archive', id]); return { threadId: id }; },
  };
  const stateStore = { projectCategories: () => [{ projectKey: 'key', projectId: 'project', path: 'C:\\Work' }],
    hiddenProject: () => null };
  const context = { codex, stateStore, getLocalTasks: async () => [{ id: taskId }] };
  assert.deepEqual((await executeTaskOperation({ action: 'projects' }, context)).projects[0].id, 'project');
  const read = await executeTaskOperation({ action: 'read', threadId: taskId }, context);
  assert.equal(read.messages[0].text, 'done');
  assert.equal(read.messages[0].secret, undefined);
  await executeTaskOperation({ action: 'send', threadId: taskId, prompt: 'go' }, context);
  await executeTaskOperation({ action: 'interrupt', threadId: taskId }, context);
  await executeTaskOperation({ action: 'archive', threadId: taskId }, context);
  await executeTaskOperation({ action: 'create', projectId: 'project', prompt: 'new' }, context);
  assert.deepEqual(calls, [['send', taskId, 'go'], ['interrupt', taskId], ['archive', taskId],
    ['startThread', 'C:\\Work'], ['send', taskId, 'new']]);
  await assert.rejects(executeTaskOperation({ action: 'interrupt', threadId: taskId },
    { ...context, getLocalTasks: async () => [] }), /not present/);
  assert.equal(calls.length, 5);
  await assert.rejects(executeTaskOperation({ action: 'create', projectId: 'project', prompt: 'new' },
    { ...context, stateStore: { ...stateStore, hiddenProject: () => ({ hidden: true }) } }), /hidden/);
});

test('authenticated effect executes once across retries and a receiver restart', async (context) => {
  let effects = 0;
  const pair = await controlPair(context, async (operation) => {
    effects += 1;
    return { threadId: operation.threadId, turnId: 'turn', mode: operation.action };
  });
  const requestId = randomUUID();
  const request = { instanceId: 'B', userId: 'user', requestId,
    operation: { action: 'send', threadId: taskId, prompt: 'go' } };
  const first = await pair.a.operatePeer(request);
  assert.equal(first.state, 'completed');
  assert.equal((await pair.a.operatePeer(request)).result.turnId, 'turn');
  assert.equal(effects, 1);
  const journalText = fs.readFileSync(pair.journalPath, 'utf8');
  assert.equal(journalText.trimEnd().split('\n').length, 2);
  assert.deepEqual(journalText.trimEnd().split('\n').map((line) => JSON.parse(line).state), ['unknown', 'completed']);
  await pair.restartB();
  assert.equal((await pair.a.operatePeer(request)).state, 'completed');
  assert.equal(effects, 1);
  await assert.rejects(pair.a.operatePeer({ ...request,
    operation: { action: 'send', threadId: taskId, prompt: 'different' } }), /409/);
  assert.equal(effects, 1);
});

test('damaged operation journal disables only effects; authenticated lists still work', async (context) => {
  let effects = 0;
  const pair = await controlPair(context, async () => { effects += 1; return {}; });
  await pair.b().stop();
  fs.writeFileSync(pair.journalPath, '{bad journal');
  await pair.restartB();
  assert.equal(pair.b().controlReady, false);
  assert.equal(pair.b().controlFailureCode, 'JOURNAL_INVALID');
  const list = await pair.a.listPeer({ instanceId: 'B', userId: 'user' });
  assert.equal(list.threads[0].id, taskId);
  await assert.rejects(pair.a.operatePeer({ instanceId: 'B', userId: 'user',
    operation: { action: 'interrupt', threadId: taskId } }), /404/);
  assert.equal(effects, 0);
});

test('uncertain effect is journaled and never retried automatically', async (context) => {
  let effects = 0;
  const pair = await controlPair(context, async () => { effects += 1; throw new Error('connection lost after effect'); });
  const request = { instanceId: 'B', userId: 'user', requestId: randomUUID(),
    operation: { action: 'interrupt', threadId: taskId } };
  assert.equal((await pair.a.operatePeer(request)).state, 'unknown');
  assert.equal((await pair.a.operatePeer(request)).state, 'unknown');
  assert.equal(effects, 1);
});

test('control refuses unauthorized operators and unconfigured peer permission', async (context) => {
  const pair = await controlPair(context, async () => ({ accepted: true }));
  await assert.rejects(pair.a.operatePeer({ instanceId: 'B', userId: 'intruder',
    operation: { action: 'status' } }), /not enabled/);
  pair.a.config.taskListPeers[0].allowTaskControl = false;
  await assert.rejects(pair.a.operatePeer({ instanceId: 'B', userId: 'user',
    operation: { action: 'status' } }), /not allowed/);
});

test('control route requires its own signature and intended target PC', async (context) => {
  let effects = 0;
  const pair = await controlPair(context, async () => { effects += 1; return { accepted: true }; });
  const route = '/v1/tasks/operate';
  const url = `http://127.0.0.1:${pair.configB.taskListListenPort}${route}`;
  const body = JSON.stringify({ instanceId: 'A', targetInstanceId: 'B', guildId: 'guild',
    userId: 'user', requestId: randomUUID(), nonce: randomUUID(),
    operation: { action: 'interrupt', threadId: taskId } });
  const send = async (keyDomain, payload = body, signed = true) => {
    const timestamp = String(Date.now());
    const key = createHmac('sha256', token).update(`${keyDomain}:app:guild`).digest();
    const signature = createHmac('sha256', key)
      .update(`${timestamp}\nPOST\n${route}\n${payload}`).digest('hex');
    return fetch(url, { method: 'POST', body: payload, headers: signed
      ? { 'x-codex-timestamp': timestamp, 'x-codex-signature': signature } : {} });
  };
  assert.equal((await send('codex-task-control-v1', body, false)).status, 401);
  assert.equal((await send('codex-task-list-v1')).status, 401);
  assert.equal((await send('codex-task-control-v1', body.replace('"targetInstanceId":"B"', '"targetInstanceId":"C"'))).status, 403);
  assert.equal((await fetch(`http://127.0.0.1:${pair.configB.taskListListenPort}/turn/start`, { method: 'POST' })).status, 404);
  assert.equal(effects, 0);
});
