import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import http from 'node:http';
import test from 'node:test';
import { TaskListFederation, mergeTaskLists, multiPcConfigErrors, resolveMultiPcConfig,
  taskListSummary } from '../src/task-list-federation.mjs';

const token = 'fake-test-bot-token';
async function freePort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function pair(context, options = {}) {
  const config = { multiPcEnabled: true, applicationId: 'app', guildId: 'guild',
    authorizedUserIds: ['user'], taskListListenHost: '127.0.0.1', taskListPeerTimeoutMs: 300 };
  const portA = await freePort();
  const portB = await freePort();
  const configA = { ...config, instanceId: 'A', taskListListenPort: portA,
    taskListPeers: [{ instanceId: 'B', url: `http://127.0.0.1:${portB}` }] };
  const configB = { ...config, instanceId: 'B', taskListListenPort: portB,
    taskListPeers: [{ instanceId: 'A', url: `http://127.0.0.1:${portA}` }] };
  const a = new TaskListFederation({ config: configA, token, getLocalTasks: async () => [{ id: 'a', name: 'Alpha', updatedAt: 1 }], ...options.a });
  const b = new TaskListFederation({ config: configB, token, getLocalTasks: async () => [{ id: 'b', name: 'Beta', updatedAt: 2 }], ...options.b });
  context.after(async () => { await a.stop(); await b.stop(); });
  await a.start();
  await b.start();
  return { a, b, configA, configB };
}

test('real independent listeners merge authenticated inventories without a leader or lock', async (context) => {
  const { a, b } = await pair(context);
  const inventory = await a.collect({ requestId: 'request', userId: 'user' });
  assert.deepEqual(inventory.threads.map(({ instanceId, id }) => [instanceId, id]), [['B', 'b'], ['A', 'a']]);
  assert.deepEqual(inventory.sources, [{ instanceId: 'A', available: true }, { instanceId: 'B', available: true }]);
  const reverse = await b.collect({ requestId: 'reverse', userId: 'user' });
  assert.deepEqual(reverse.threads.map((thread) => thread.id), ['b', 'a']);
});

test('offline peer is explicit and does not block the local inventory', async (context) => {
  const { a, b } = await pair(context);
  await b.stop();
  const inventory = await a.collect({ requestId: 'offline', userId: 'user' });
  assert.deepEqual(inventory.threads.map((thread) => thread.id), ['a']);
  assert.deepEqual(inventory.sources.find((source) => source.instanceId === 'B'), { instanceId: 'B', available: false });
});

test('slow peer times out, while search is passed to each independent local query', async (context) => {
  const searches = [];
  const { a } = await pair(context, {
    a: { getLocalTasks: async (search) => { searches.push(['A', search]); return []; } },
    b: { getLocalTasks: async (search) => { searches.push(['B', search]); return new Promise(() => {}); } },
  });
  const started = Date.now();
  const inventory = await a.collect({ requestId: 'slow', userId: 'user', search: 'needle' });
  assert.ok(Date.now() - started < 2000);
  assert.deepEqual(searches, [['A', 'needle'], ['B', 'needle']]);
  assert.equal(inventory.sources[1].available, false);
});

test('list server rejects unsigned, unauthorized, replayed and effectful requests', async (context) => {
  const { a, b, configB } = await pair(context);
  const url = `http://127.0.0.1:${configB.taskListListenPort}`;
  const key = createHmac('sha256', token).update('codex-task-list-v1:app:guild').digest();
  const send = async (input, { signed = true, route = '/v1/tasks/list', timestamp = String(Date.now()) } = {}) => {
    const body = JSON.stringify(input);
    const signature = createHmac('sha256', key).update(`${timestamp}\nPOST\n${route}\n${body}`).digest('hex');
    return fetch(`${url}${route}`, { method: 'POST', body,
      headers: signed ? { 'x-codex-timestamp': timestamp, 'x-codex-signature': signature } : {} });
  };
  const input = { instanceId: 'A', guildId: 'guild', userId: 'user', search: null, requestId: 'request', nonce: 'nonce-1234567890123456' };
  assert.equal((await send(input, { signed: false })).status, 401);
  assert.equal((await send({ ...input, userId: 'intruder' })).status, 403);
  assert.equal((await send(input, { timestamp: String(Date.now() - 60000) })).status, 401);
  assert.equal((await send(input, { route: '/turn/start' })).status, 404);
  assert.equal((await send(input)).status, 200);
  assert.equal((await send(input)).status, 409);
  await assert.rejects(a.collect({ requestId: 'request', userId: 'intruder' }), /authorized/);
  assert.ok(b.server);
});

test('inventories expose summaries only; repeated IDs on distinct PCs retain explicit owners', () => {
  const thread = { id: 'duplicate', name: 'Task', turns: ['secret-history'], prompt: 'secret', token: 'secret' };
  const summary = taskListSummary(thread);
  assert.equal(summary.turns, undefined);
  assert.equal(summary.prompt, undefined);
  const merged = mergeTaskLists([{ instanceId: 'A', threads: [summary, summary] }, { instanceId: 'B', threads: [summary] }]);
  assert.deepEqual(merged.map((entry) => entry.instanceId), ['A', 'B']);
});

test('multi-PC config disallows public listeners, unsafe peers and duplicated instance identities', () => {
  const config = { multiPcEnabled: true, instanceId: 'A', taskListListenHost: '100.75.107.79', taskListListenPort: 18799,
    taskListPeerTimeoutMs: 8000, taskListPeers: [{ instanceId: 'B', url: 'http://100.104.140.74:18799' }] };
  assert.deepEqual(multiPcConfigErrors(config), []);
  for (const host of ['0.0.0.0', '192.168.0.1', 'example.com', '100.1.2.3']) {
    assert.ok(multiPcConfigErrors({ ...config, taskListListenHost: host }).length);
  }
  for (const url of ['http://example.com', 'http://100.104.140.74/path', 'http://secret@100.104.140.74', 'http://100.104.140.74?x=1']) {
    assert.ok(multiPcConfigErrors({ ...config, taskListPeers: [{ instanceId: 'B', url }] }).length);
  }
  assert.ok(multiPcConfigErrors({ ...config, taskListPeers: [{ instanceId: 'A', url: 'http://100.104.140.74' }] }).length);
  const scoped = resolveMultiPcConfig({ ...config, controlCategoryName: 'Codex Control', archiveCategoryName: 'Codex Archived',
    transferCategoryName: 'Others', chatgptCategoryName: 'ChatGPT', projectCategoryPrefix: 'Codex - ' });
  assert.equal(scoped.controlCategoryName, 'Codex Control [A]');
  assert.equal(scoped.projectCategoryPrefix, 'Codex - A - ');
});
