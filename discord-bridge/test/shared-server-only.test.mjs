import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { WebSocketServer } from 'ws';
import { CodexService } from '../src/codex-service.mjs';
import { inspectDesktopClientOwner } from '../src/client-tool-ownership.mjs';

const THREAD = '01a1abbd-0000-7000-8000-000000000001';

test('server-only connects and lists, reads, starts and steers without Desktop preparation', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-server-only-'));
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const url = `ws://127.0.0.1:${server.address().port}`;
  const launcherStatePath = path.join(directory, 'current.json');
  const state = {
    websocketUrl: url, mode: 'server', serverProcessId: 100,
    startedAt: '2026-11-11T00:00:00Z', desktopProcessIds: [], desktopConnectionVerified: false,
  };
  fs.writeFileSync(launcherStatePath, JSON.stringify(state));
  const calls = [];
  let activeTurn = null;
  server.on('connection', (socket) => {
    socket.on('message', (data) => {
      const request = JSON.parse(data.toString());
      if (request.id == null) return;
      calls.push(request);
      let result = {};
      if (request.method === 'thread/list') result = { data: [{ id: THREAD }], nextCursor: null };
      if (request.method === 'thread/read' || request.method === 'thread/resume') {
        result = { thread: { id: THREAD, status: { type: activeTurn ? 'active' : 'idle' } } };
      }
      if (request.method === 'thread/start') result = { thread: { id: THREAD, cwd: request.params.cwd } };
      if (request.method === 'thread/turns/list') result = { data: activeTurn ? [activeTurn] : [] };
      if (request.method === 'turn/start') {
        activeTurn = { id: 'accepted-start', status: 'inProgress' };
        result = { turn: activeTurn };
      }
      if (request.method === 'turn/steer') result = { turnId: activeTurn.id };
      socket.send(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
    });
  });
  const preparations = [];
  const service = new CodexService({
    config: { launcherStatePath, autoStartSharedDesktop: false },
    stateStore: { bindings: () => [], projectCategories: () => [] },
    discoverEndpoint: () => ({ url, source: 'launcher' }),
    inspectDesktopOwner: (options) => inspectDesktopClientOwner({
      ...options, isProcessAlive: (pid) => pid === 100,
    }),
    desktopFirst: { prepare: (id) => { preparations.push(id); return 'waiting'; } },
    logDir: directory,
  });
  t.after(async () => {
    await service.stop();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const connected = once(service, 'subscriptionsReady');
  service.start();
  await connected;
  assert.equal(service.connected, true);
  assert.deepEqual((await service.listThreads()).data, [{ id: THREAD }]);
  assert.equal((await service.readThread(THREAD)).thread.id, THREAD);
  assert.equal((await service.startThread('C:/work')).thread.cwd, 'C:/work');
  assert.equal((await service.deliver(THREAD, 'first', null, 'input-one')).turnId, 'accepted-start');
  assert.equal((await service.deliver(THREAD, 'second', null, 'input-two')).turnId, 'accepted-start');
  assert.deepEqual(preparations, []);
  assert.equal(service.browserInitializationGeneration(), null);
  assert.equal(await service.withBrowserArchive(THREAD, () => assert.fail('Desktop browser recovery ran')), false);
  assert.deepEqual(calls.filter(({ method }) => method === 'turn/start' || method === 'turn/steer')
    .map(({ method, params }) => ({ method, params })), [
    { method: 'turn/start', params: {
      threadId: THREAD, input: [{ type: 'text', text: 'first' }], clientUserMessageId: 'input-one',
    } },
    { method: 'turn/steer', params: {
      threadId: THREAD, input: [{ type: 'text', text: 'second' }],
      expectedTurnId: 'accepted-start', clientUserMessageId: 'input-two',
    } },
  ]);

  fs.writeFileSync(launcherStatePath, JSON.stringify({ ...state, serverProcessId: 101 }));
  const before = calls.length;
  await assert.rejects(service.listThreads(), /ownership is unverified/);
  await assert.rejects(service.deliver(THREAD, 'blocked', null, 'input-three'), /ownership is unverified/);
  assert.equal(calls.length, before);
});

test('a connected generation can lose Desktop and regain its original preparation path', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-owner-transition-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let owner = { state: 'present', generation: 'one' };
  const preparations = [];
  const calls = [];
  const service = new CodexService({
    config: {}, stateStore: {}, logDir: directory, inspectDesktopOwner: () => owner,
    desktopFirst: { prepare: (id) => { preparations.push(id); return 'waiting'; } },
  });
  service.clientGeneration = 'one';
  service.client = { connected: true, call: async (method) => {
    calls.push(method);
    if (method === 'thread/turns/list') return { data: [] };
    if (method === 'turn/start') return { turn: { id: 'accepted' } };
    return {};
  } };
  await assert.rejects(service.deliver(THREAD, 'pending', null, 'one'), { code: 'DESKTOP_THREAD_PENDING' });
  assert.deepEqual(calls, []);
  owner = { state: 'absent', generation: 'one' };
  assert.equal((await service.deliver(THREAD, 'send', null, 'two')).turnId, 'accepted');
  owner = { state: 'present', generation: 'one' };
  await assert.rejects(service.deliver(THREAD, 'pending again', null, 'three'), { code: 'DESKTOP_THREAD_PENDING' });
  assert.deepEqual(preparations, [THREAD, THREAD]);
  assert.deepEqual(calls, ['thread/resume', 'thread/turns/list', 'turn/start']);
  for (const next of [
    { state: 'ambiguous', generation: 'one' },
    { state: 'absent', generation: 'replacement' },
    { state: 'absent', generation: null },
  ]) {
    owner = next;
    await assert.rejects(service.readThread(THREAD), /ownership is unverified/);
    await assert.rejects(service.resumeThread(THREAD), /ownership is unverified/);
  }
  assert.deepEqual(calls, ['thread/resume', 'thread/turns/list', 'turn/start']);
});

test('Desktop returning during headless preparation defers delivery to its owner', async () => {
  let owner = { state: 'absent', generation: 'one' };
  const service = new CodexService({
    config: {}, stateStore: {}, logDir: os.tmpdir(), inspectDesktopOwner: () => owner,
  });
  service.clientGeneration = 'one';
  service.client = { connected: true, call: () => assert.fail('Delivery raced the returning Desktop') };
  const pending = service.resumeThread(THREAD);
  owner = { state: 'present', generation: 'one' };
  await assert.rejects(pending, { code: 'DESKTOP_THREAD_PENDING' });
});

test('an unknown turn outcome is propagated without retry when Desktop disappears', async () => {
  let owner = { state: 'absent', generation: 'one' };
  let starts = 0;
  const service = new CodexService({
    config: {}, stateStore: {}, logDir: os.tmpdir(), inspectDesktopOwner: () => owner,
  });
  service.clientGeneration = 'one';
  service.client = { connected: true, call: async (method) => {
    if (method === 'thread/turns/list') return { data: [] };
    if (method === 'turn/start') {
      starts += 1;
      owner = { state: 'ambiguous', generation: 'one' };
      throw new Error('turn/start outcome unknown');
    }
    return {};
  } };
  await assert.rejects(service.deliver(THREAD, 'send', null, 'one'), /outcome unknown/);
  await setImmediate();
  assert.equal(starts, 1);
});
