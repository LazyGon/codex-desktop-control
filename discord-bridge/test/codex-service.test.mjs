import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { CodexService } from '../src/codex-service.mjs';
import { StateStore } from '../src/state-store.mjs';

test('CodexService restores subscriptions and forwards live notifications', async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-discord-service-'));
  const server = new WebSocketServer({ port: 0 });
  await new Promise((resolve) => server.once('listening', resolve));
  const url = `ws://127.0.0.1:${server.address().port}`;
  const stateStore = new StateStore(directory, '123456789012345');
  stateStore.setBinding('thread-1', {
    channelId: 'channel-1',
    watchLevel: 'normal',
    lastCompletedTurnId: 'old-turn',
    lastNotifiedCompletedTurnId: 'old-turn',
  });
  stateStore.setBinding('thread-archived', {
    channelId: 'channel-archived',
    archived: true,
  });

  let peer;
  const resumedThreads = [];
  const listArchivedFilters = [];
  const startedThreads = [];
  const namedThreads = [];
  const controlCalls = [];
  server.on('connection', (socket) => {
    peer = socket;
    socket.on('message', (data) => {
      const request = JSON.parse(data.toString());
      let result = {};
      if (request.method === 'initialize') result = { userAgent: 'mock' };
      if (request.method === 'thread/resume') {
        resumedThreads.push(request.params.threadId);
        result = { thread: { id: request.params.threadId } };
      }
      if (request.method === 'thread/start') {
        startedThreads.push(request.params);
        result = { thread: { id: 'thread-new', cwd: request.params.cwd, status: { type: 'idle' } } };
      }
      if (request.method === 'thread/name/set') {
        namedThreads.push(request.params);
        result = {};
      }
      if (request.method === 'thread/settings/update') {
        controlCalls.push([request.method, request.params]);
        result = {};
      }
      if (request.method === 'model/list') result = { data: [{ model: 'gpt-test' }], nextCursor: null };
      if (request.method === 'permissionProfile/list') result = { data: [{ id: ':workspace', allowed: true }], nextCursor: null };
      if (request.method === 'collaborationMode/list') result = { data: [{ name: 'Default', mode: 'default' }] };
      if (request.method === 'thread/goal/get') result = { goal: null };
      if (request.method === 'thread/goal/set') result = { goal: { threadId: request.params.threadId, objective: request.params.objective } };
      if (request.method === 'thread/goal/clear') result = { cleared: true };
      if (request.method === 'thread/compact/start') result = {};
      if (request.method === 'thread/fork') result = { thread: { id: 'thread-fork' } };
      if (request.method === 'review/start') result = { turn: { id: 'review-turn' }, reviewThreadId: request.params.threadId };
      if (request.method === 'thread/backgroundTerminals/list') result = { data: [{ processId: 'process-1' }], nextCursor: null };
      if (request.method === 'thread/backgroundTerminals/terminate') result = { terminated: true };
      if (request.method === 'thread/memoryMode/set') result = {};
      if (request.method === 'account/rateLimits/read') result = { rateLimits: { primary: null } };
      if (request.method === 'account/usage/read') result = { summary: { lifetimeTokens: 42 } };
      if (request.method === 'mcpServerStatus/list') result = { data: [{ name: 'mock-mcp' }], nextCursor: null };
      if (request.method === 'skills/list') result = { data: [{ cwd: 'C:/work', skills: [] }] };
      if (request.method === 'hooks/list') result = { data: [{ cwd: 'C:/work', hooks: [] }] };
      if (request.method === 'plugin/list') result = { marketplaces: [] };
      if (request.method === 'experimentalFeature/list') result = { data: [{ name: 'mock-feature' }], nextCursor: null };
      if (request.method === 'thread/read') {
        result = {
          thread: {
            id: 'thread-1',
            name: 'Mock task',
            cwd: 'C:/work',
            status: { type: 'idle' },
            turns: [{
              id: 'new-turn',
              status: 'completed',
              items: [{ type: 'agentMessage', phase: 'final_answer', text: 'finished offline' }],
            }],
          },
        };
      }
      if (request.method === 'thread/list') {
        listArchivedFilters.push(request.params.archived);
        result = request.params.cursor === 'page-2'
          ? { data: [{ id: 'thread-2', cwd: 'C:/work' }], nextCursor: null }
          : { data: [{ id: 'thread-1', cwd: 'C:/work' }], nextCursor: 'page-2' };
      }
      socket.send(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
    });
  });

  const service = new CodexService({
    config: { autoStartSharedDesktop: false, taskListLimit: 20 },
    stateStore,
    discoverEndpoint: () => ({ url, source: 'test' }),
    logDir: directory,
  });
  context.after(async () => {
    await service.stop();
    server.close();
    const resolved = path.resolve(directory);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir())));
    fs.rmSync(resolved, { recursive: true, force: true });
  });

  const restoredPromise = new Promise((resolve) => service.once('subscriptionRestored', resolve));
  service.start();
  const restored = await restoredPromise;
  assert.equal(restored.thread.id, 'thread-1');
  assert.equal(restored.runtime.thread.id, 'thread-1');
  assert.equal(restored.missedCompletion.turn.id, 'new-turn');
  assert.equal(restored.missedCompletion.finalText, 'finished offline');
  assert.equal(restored.missedCompletion.needsCompletionMessage, true);
  assert.equal(restored.missedCompletion.needsCompletionNotice, true);

  const allThreads = await service.listAllThreads({ archived: true });
  assert.deepEqual(allThreads.map((thread) => thread.id), ['thread-1', 'thread-2']);
  assert.deepEqual(listArchivedFilters, [true, true]);
  assert.deepEqual(resumedThreads, ['thread-1']);

  const started = await service.startThread('C:\\new-work');
  await service.setThreadName(started.thread.id, 'New work');
  assert.equal(started.thread.id, 'thread-new');
  assert.deepEqual(startedThreads, [{ cwd: 'C:\\new-work' }]);
  assert.deepEqual(namedThreads, [{ threadId: 'thread-new', name: 'New work' }]);

  await service.updateThreadSettings('thread-1', { model: 'gpt-test' });
  assert.deepEqual(await service.listModels(), [{ model: 'gpt-test' }]);
  assert.deepEqual(await service.listPermissionProfiles('C:/work'), [{ id: ':workspace', allowed: true }]);
  assert.deepEqual(await service.listCollaborationModes(), [{ name: 'Default', mode: 'default' }]);
  assert.deepEqual(await service.getGoal('thread-1'), { goal: null });
  assert.equal((await service.setGoal('thread-1', 'Ship it', 1000)).goal.objective, 'Ship it');
  assert.equal((await service.clearGoal('thread-1')).cleared, true);
  await service.compactThread('thread-1');
  assert.equal((await service.forkThread('thread-1')).thread.id, 'thread-fork');
  assert.equal((await service.startReview('thread-1', { type: 'uncommittedChanges' })).turn.id, 'review-turn');
  assert.deepEqual(await service.listBackgroundTerminals('thread-1'), [{ processId: 'process-1' }]);
  assert.equal((await service.terminateBackgroundTerminal('thread-1', 'process-1')).terminated, true);
  await service.setMemoryMode('thread-1', 'enabled');
  assert.equal((await service.accountUsage()).summary.lifetimeTokens, 42);
  assert.deepEqual(await service.listMcpServers('thread-1'), [{ name: 'mock-mcp' }]);
  assert.equal((await service.listSkills(['C:/work'])).data[0].cwd, 'C:/work');
  assert.equal((await service.listHooks(['C:/work'])).data[0].cwd, 'C:/work');
  assert.deepEqual((await service.listPlugins()).marketplaces, []);
  assert.deepEqual(await service.listExperimentalFeatures('thread-1'), [{ name: 'mock-feature' }]);
  assert.deepEqual(controlCalls, [[
    'thread/settings/update',
    { threadId: 'thread-1', model: 'gpt-test' },
  ]]);

  const notificationPromise = new Promise((resolve) => service.once('notification', resolve));
  peer.send(JSON.stringify({ jsonrpc: '2.0', method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'live-turn' } } }));
  const notification = await notificationPromise;
  assert.equal(notification.params.turn.id, 'live-turn');
});
