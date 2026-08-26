import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import {
  CodexService,
  forEachConcurrent,
  subscriptionRestoreBindings,
  threadForSubscriptionRestore,
} from '../src/codex-service.mjs';
import { StateStore } from '../src/state-store.mjs';

test('subscription restore prioritizes recent active tasks and remains bounded across tasks', async () => {
  const ordered = subscriptionRestoreBindings([
    { threadId: 'idle', taskStatus: 'idle', updatedAt: '2026-08-24T12:00:00Z' },
    { threadId: 'active-old', taskStatus: 'active', updatedAt: '2026-08-24T10:00:00Z' },
    { threadId: 'archived', taskStatus: 'active', archived: true, updatedAt: '2026-08-24T13:00:00Z' },
    { threadId: 'active-new', taskStatus: 'active', updatedAt: '2026-08-24T11:00:00Z' },
  ]);
  assert.deepEqual(ordered.map((binding) => binding.threadId), [
    'active-new',
    'active-old',
    'idle',
  ]);

  let active = 0;
  let maximum = 0;
  await forEachConcurrent(ordered, 2, async () => {
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
  });
  assert.equal(maximum, 2);
});

test('subscription restore excludes completed history inherited from a fork source', () => {
  const inherited = { id: 'inherited', completedAt: 100 };
  const own = { id: 'own', startedAt: 200 };
  const thread = { id: 'forked-thread', turns: [inherited, own] };
  assert.deepEqual(threadForSubscriptionRestore({
    forkedFromThreadId: 'source-thread',
    forkedAtMs: 150_000,
  }, thread).turns, [own]);
  assert.equal(threadForSubscriptionRestore({}, thread), thread);
});

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
  const listProjectFilters = [];
  const startedThreads = [];
  const namedThreads = [];
  const controlCalls = [];
  const turnStarts = [];
  const turnSteers = [];
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
      if (request.method === 'project/list') result = request.params.cursor === 'project-page-2'
        ? { data: [{ id: 'project-2' }], nextCursor: null }
        : { data: [{ id: 'project-1' }], nextCursor: 'project-page-2' };
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
        listProjectFilters.push(request.params.projectId ?? null);
        result = request.params.cursor === 'page-2'
          ? { data: [{ id: 'thread-2', cwd: 'C:/work' }], nextCursor: null }
          : { data: [{ id: 'thread-1', cwd: 'C:/work' }], nextCursor: 'page-2' };
      }
      if (request.method === 'thread/turns/list') result = { data: [], nextCursor: null };
      if (request.method === 'turn/start') {
        turnStarts.push(request.params);
        result = { turn: { id: 'turn-started' } };
      }
      if (request.method === 'turn/steer') {
        turnSteers.push(request.params);
        result = { turnId: request.params.expectedTurnId };
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
  assert.deepEqual(listProjectFilters, [null, null]);
  const projectThreads = await service.listAllThreads({ projectId: 'project-1' });
  assert.deepEqual(projectThreads.map((thread) => thread.id), ['thread-1', 'thread-2']);
  assert.deepEqual(listProjectFilters.slice(-2), ['project-1', 'project-1']);
  assert.deepEqual(await service.listAllProjects(), [{ id: 'project-1' }, { id: 'project-2' }]);
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

  const sent = await service.send('thread-1', 'start input', [
    {
      kind: 'localImage',
      name: 'screen.png',
      path: 'C:\\runtime\\screen.png',
      size: 120,
      contentType: 'image/png',
    },
    {
      kind: 'file',
      name: 'report.pdf',
      path: 'C:\\runtime\\report.pdf',
      size: 456,
      contentType: 'application/pdf',
    },
  ], 'client-start');
  const steered = await service.steer(
    'thread-1',
    'steer input',
    [{
      kind: 'file',
      name: 'source.zip',
      path: 'C:\\runtime\\source.zip',
      size: 789,
      contentType: 'application/zip',
    }],
    'client-steer',
    { id: 'turn-active' },
  );
  assert.equal(sent.turnId, 'turn-started');
  assert.equal(steered.turnId, 'turn-active');
  assert.deepEqual(turnStarts, [{
    threadId: 'thread-1',
    input: [
      {
        type: 'text',
        text: 'start input\n\n# Files mentioned by the user:\n- [report.pdf](<C:/runtime/report.pdf>) (application/pdf, 456 bytes)',
      },
      { type: 'localImage', path: 'C:\\runtime\\screen.png' },
    ],
    clientUserMessageId: 'client-start',
  }]);
  assert.deepEqual(turnSteers, [{
    threadId: 'thread-1',
    expectedTurnId: 'turn-active',
    input: [{
      type: 'text',
      text: 'steer input\n\n# Files mentioned by the user:\n- [source.zip](<C:/runtime/source.zip>) (application/zip, 789 bytes)',
    }],
    clientUserMessageId: 'client-steer',
  }]);

  const notificationPromise = new Promise((resolve) => service.once('notification', resolve));
  peer.send(JSON.stringify({ jsonrpc: '2.0', method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'live-turn' } } }));
  const notification = await notificationPromise;
  assert.equal(notification.params.turn.id, 'live-turn');

  const deltaPromise = new Promise((resolve) => service.once('notification', resolve));
  peer.send(JSON.stringify({
    jsonrpc: '2.0',
    method: 'item/agentMessage/delta',
    params: { threadId: 'thread-1', turnId: 'live-turn', itemId: 'message-1', delta: 'secret body' },
  }));
  await deltaPromise;
  const completedPromise = new Promise((resolve) => service.once('notification', resolve));
  peer.send(JSON.stringify({
    jsonrpc: '2.0',
    method: 'turn/completed',
    params: { threadId: 'thread-1', turn: { id: 'live-turn', status: 'completed', items: [] } },
  }));
  await completedPromise;

  const codexLog = fs.readdirSync(directory).find((name) => /^codex-\d+\.jsonl$/.test(name));
  const logText = fs.readFileSync(path.join(directory, codexLog), 'utf8');
  assert.doesNotMatch(logText, /item\/agentMessage\/delta/);
  assert.match(logText, /turn\/completed/);
});

test('CodexService fallback starts the shared launcher without interactive dialogs', async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-service-launcher-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const launcherPath = path.join(directory, 'CodexSharedLauncher.exe');
  fs.writeFileSync(launcherPath, 'fixture');

  let spawned;
  const service = new CodexService({
    config: { autoStartSharedDesktop: true, sharedLauncherPath: launcherPath, taskListLimit: 20 },
    stateStore: { bindings: () => [], projectCategories: () => [] },
    discoverEndpoint: () => ({ url: 'ws://127.0.0.1:1', source: 'test' }),
    logDir: directory,
    spawnProcess: (file, args, options) => {
      spawned = { file, args, options, unrefCalled: false };
      return {
        pid: 12345,
        unref() { spawned.unrefCalled = true; },
      };
    },
  });
  context.after(() => service.stop());
  const launcherStarted = new Promise((resolve) => service.once('launcherStarted', resolve));
  service.start();

  const event = await launcherStarted;
  assert.equal(event.launcherPath, launcherPath);
  assert.equal(spawned.file, launcherPath);
  assert.deepEqual(spawned.args, ['--no-dialogs']);
  assert.equal(spawned.options.detached, true);
  assert.equal(spawned.options.windowsHide, true);
  assert.equal(spawned.unrefCalled, true);
});
