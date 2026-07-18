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

  const notificationPromise = new Promise((resolve) => service.once('notification', resolve));
  peer.send(JSON.stringify({ jsonrpc: '2.0', method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'live-turn' } } }));
  const notification = await notificationPromise;
  assert.equal(notification.params.turn.id, 'live-turn');
});
