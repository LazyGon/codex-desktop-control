import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ChannelType, EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import {
  ATTACHMENT_ONLY_PROMPT,
  completionRecoveryCandidate,
  DiscordController,
  emptyDuplicateUserEntryIds,
  forkOwnTurns,
  isActiveSubagentThread,
  isManagedProjectCategoryName,
  isSubagentCodexThread,
  managedArchiveCategoryCleanupPlan,
  managedProjectCategoryCleanupPlan,
  managedProjectCategoryNames,
  orderedSessionCardItems,
  postTaskSyncSummary,
  projectVisibilityCatalog,
  runAfterTranscriptBarrier,
  sessionOrderRepairMessageIds,
  shouldCleanupOnlyExistingFork,
  shouldPeriodicallySyncSubagent,
  subagentDiscordThreadName,
  subagentIdsFromThread,
  subagentMetadata,
  subagentOwnTurns,
} from '../src/discord-controller.mjs';
import {
  CONTROL_PANEL_COLOR,
  CONTROL_PANEL_MARKER,
  taskPanelMarker,
} from '../src/discord-panels.mjs';
import { discover7Zip } from '../src/split-archive.mjs';
import { StateStore } from '../src/state-store.mjs';
import { readSessionTurnCardOrder } from '../src/session-message-order.mjs';

test('managed project category cleanup removes empty overflow categories but preserves occupied ones', () => {
  const category = (id, children) => ({
    id,
    children: { cache: { size: children } },
  });
  const primary = category('primary', 3);
  const occupiedOverflow = category('occupied-overflow', 1);
  const emptyOverflow = category('empty-overflow', 0);

  assert.deepEqual(
    managedProjectCategoryCleanupPlan([primary, emptyOverflow], true),
    { keep: [primary], remove: [emptyOverflow], removeProject: false },
  );
  assert.deepEqual(
    managedProjectCategoryCleanupPlan([primary, occupiedOverflow, emptyOverflow], true),
    {
      keep: [primary, occupiedOverflow],
      remove: [emptyOverflow],
      removeProject: false,
    },
  );
  assert.deepEqual(
    managedProjectCategoryCleanupPlan([emptyOverflow], false),
    { keep: [], remove: [emptyOverflow], removeProject: true },
  );
});

test('managed archive category cleanup removes empty overflow and preserves one empty base', () => {
  const category = (id, children) => ({
    id,
    children: { cache: { size: children } },
  });
  const base = category('base', 50);
  const occupiedOverflow = category('occupied-overflow', 2);
  const emptyOverflow = category('empty-overflow', 0);

  assert.deepEqual(
    managedArchiveCategoryCleanupPlan([base, occupiedOverflow, emptyOverflow]),
    { keep: [base, occupiedOverflow], remove: [emptyOverflow] },
  );
  assert.deepEqual(
    managedArchiveCategoryCleanupPlan([category('empty-base', 0), emptyOverflow]),
    { keep: [{ id: 'empty-base', children: { cache: { size: 0 } } }], remove: [emptyOverflow] },
  );
});

test('managed project category namespace includes orphaned overflow names only', () => {
  assert.equal(isManagedProjectCategoryName('Codex - economic-support (2)', 'Codex - '), true);
  assert.equal(isManagedProjectCategoryName('Codex - other (2)', 'Codex - '), true);
  assert.equal(isManagedProjectCategoryName('Codex Archived (3)', 'Codex - '), false);
  assert.equal(isManagedProjectCategoryName('Codex - ', 'Codex - '), false);
  assert.equal(isManagedProjectCategoryName('Personal category', 'Codex - '), false);
});

test('managed project category names drop stale collision suffixes once the Desktop name is unique', () => {
  const descriptor = {
    key: 'local-project-1',
    name: 'Codex - Example',
  };
  assert.deepEqual(managedProjectCategoryNames(descriptor, [{
    projectKey: descriptor.key,
    name: 'Codex - Example - stale1',
  }], 2), [
    'Codex - Example',
    'Codex - Example (2)',
  ]);

  const suffix = Buffer.from(descriptor.key, 'utf8').toString('base64url').slice(-6).toLowerCase();
  assert.deepEqual(managedProjectCategoryNames(descriptor, [{
    projectKey: 'local-project-2',
    name: descriptor.name,
  }], 1), [`Codex - Example - ${suffix}`]);
});

test('task sync summaries use the dedicated sync channel instead of the control panel channel', async () => {
  const fetched = [];
  const sent = [];
  const client = {
    channels: {
      fetch: async (channelId) => {
        fetched.push(channelId);
        return channelId === 'sync-channel'
          ? { send: async (payload) => { sent.push(payload); } }
          : null;
      },
    },
  };
  const stateStore = {
    snapshot: () => ({
      infrastructure: {
        controlChannelId: 'control-channel',
        syncChannelId: 'sync-channel',
      },
    }),
  };

  assert.equal(await postTaskSyncSummary(client, stateStore, {
    created: 1,
    moved: 2,
    deleted: 0,
    failed: 0,
    channels: ['task-channel'],
  }), true);
  assert.deepEqual(fetched, ['sync-channel']);
  assert.equal(sent.length, 1);
  assert.match(sent[0].content, /新規 1 \/ 移動 2/);
  assert.match(sent[0].content, /<#task-channel>/);
  assert.deepEqual(sent[0].allowedMentions, { parse: [] });
});

test('control channel messages replace the unpinned control card at the latest position', async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-control-panel-latest-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const stateStore = new StateStore(directory, 'guild-1');
  stateStore.setInfrastructure({
    controlChannelId: 'control-channel',
    controlPanelMessageId: 'control-panel-old',
  });

  const client = new EventEmitter();
  client.user = { id: 'bot-user' };
  const codex = new EventEmitter();
  codex.connected = true;
  const messages = new Map();
  let sent = 0;
  let oldPanelUnpinned = 0;
  let oldPanelDeleted = 0;
  let newPanelPinned = 0;
  const collection = (entries) => Object.assign(new Map(entries), {
    first() { return this.values().next().value ?? null; },
  });
  const makeMessage = (id, payload = {}) => {
    const message = {
      id,
      guildId: 'guild-1',
      channelId: 'control-channel',
      author: payload.author ?? { id: 'bot-user', bot: true },
      webhookId: null,
      content: payload.content ?? '',
      embeds: (payload.embeds ?? []).map((embed) => embed.toJSON?.() ?? embed),
      components: (payload.components ?? []).map((component) => component.toJSON?.() ?? component),
      pinned: Boolean(payload.pinned),
      edit: async (next) => {
        message.content = next.content ?? message.content;
        if (next.embeds) message.embeds = next.embeds.map((embed) => embed.toJSON?.() ?? embed);
        if (next.components) message.components = next.components.map((component) => component.toJSON?.() ?? component);
        return message;
      },
      pin: async () => {
        newPanelPinned += 1;
        message.pinned = true;
        return message;
      },
      unpin: async () => {
        message.pinned = false;
        if (message.id === 'control-panel-old') oldPanelUnpinned += 1;
        return message;
      },
      delete: async () => {
        messages.delete(message.id);
        if (message.id === 'control-panel-old') oldPanelDeleted += 1;
      },
    };
    messages.set(id, message);
    return message;
  };
  makeMessage('control-panel-old', {
    embeds: [{ footer: { text: CONTROL_PANEL_MARKER } }],
    pinned: true,
  });
  const laterMessage = makeMessage('later-message', {
    author: { id: 'user-1', bot: false },
    content: 'ordinary control-channel message',
  });
  const control = {
    id: 'control-channel',
    messages: {
      fetch: async (value) => {
        if (typeof value === 'string') return messages.get(value) ?? null;
        const limit = value?.limit ?? messages.size;
        return collection([...messages].reverse().slice(0, limit));
      },
      fetchPinned: async () => collection([...messages].filter(([, message]) => message.pinned)),
    },
    send: async (payload) => {
      sent += 1;
      return makeMessage(`control-panel-new-${sent}`, payload);
    },
  };
  client.channels = { fetch: async () => control };
  const controller = new DiscordController({
    client,
    codex,
    stateStore,
    config: {
      guildId: 'guild-1',
      authorizedUserIds: ['user-1'],
      textTransferEnabled: false,
      plainMessageInputEnabled: false,
    },
    logDir: directory,
  });
  controller.infrastructureReady = Promise.resolve({ control });
  controller.attach();

  client.emit('messageCreate', laterMessage);
  for (let attempt = 0; attempt < 100 && controller.discordMessageQueues.size; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  const panelId = stateStore.snapshot().infrastructure.controlPanelMessageId;
  const panel = messages.get(panelId);
  assert.equal(sent, 1);
  assert.equal(panelId, 'control-panel-new-1');
  assert.equal([...messages.keys()].at(-1), panelId);
  assert.equal(panel.pinned, false);
  assert.equal(panel.embeds[0].footer.text, CONTROL_PANEL_MARKER);
  assert.equal(newPanelPinned, 0);
  assert.equal(oldPanelUnpinned, 1);
  assert.equal(oldPanelDeleted, 1);

  client.emit('messageCreate', panel);
  for (let attempt = 0; attempt < 100 && controller.discordMessageQueues.size; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(sent, 1);
});

test('project visibility catalog merges active and hidden projects without losing task counts', () => {
  const projects = projectVisibilityCatalog({
    categoryPrefix: 'Codex - ',
    projectCategories: [{
      projectKey: 'c:\\git\\visible',
      projectId: 'prj_visible',
      path: 'C:\\git\\visible',
      name: 'Codex - visible',
    }],
    hiddenProjects: [{
      projectKey: 'c:\\git\\hidden',
      projectId: 'prj_hidden',
      path: 'C:\\git\\hidden',
      name: 'Codex - hidden',
    }],
    bindings: [
      { projectKey: 'c:\\git\\visible', cwd: 'C:\\git\\visible' },
      { projectKey: 'c:\\git\\visible', cwd: 'C:\\git\\visible' },
      { projectKey: 'c:\\git\\hidden', cwd: 'C:\\git\\hidden', hidden: true },
    ],
  });
  assert.deepEqual(projects.map((project) => ({
    key: project.projectKey,
    hidden: project.hidden,
    tasks: project.taskCount,
  })), [
    { key: 'c:\\git\\visible', hidden: false, tasks: 2 },
    { key: 'c:\\git\\hidden', hidden: true, tasks: 1 },
  ]);
});

test('session card ordering keeps steer messages inside the active instruction sequence', () => {
  const initial = { id: 'user-initial', text: 'start' };
  const steer = { id: 'user-steer', text: 'adjust' };
  const beforeSteer = { id: 'assistant-before', phase: 'commentary', text: 'working' };
  const afterSteer = { id: 'assistant-after', phase: 'commentary', text: 'adjusted' };
  const turn = {
    items: [
      { type: 'userMessage', id: initial.id },
      { type: 'agentMessage', ...beforeSteer },
      { type: 'userMessage', id: steer.id },
      { type: 'agentMessage', ...afterSteer },
      { type: 'agentMessage', id: 'final', phase: 'final_answer', text: 'done' },
    ],
  };

  assert.deepEqual(
    orderedSessionCardItems(turn, [initial, steer], [beforeSteer, afterSteer], [
      { kind: 'user', id: initial.id },
      { kind: 'detail', id: beforeSteer.id },
      { kind: 'user', id: steer.id },
      { kind: 'detail', id: afterSteer.id },
    ])
      .map(({ kind, item }) => `${kind}:${item.id}`),
    [
      'user:user-initial',
      'detail:assistant-before',
      'user:user-steer',
      'detail:assistant-after',
    ],
  );
});

test('fork transcript keeps only turns created at or after the fork', () => {
  const inherited = { id: 'inherited-turn', completedAt: 100 };
  const own = { id: 'own-turn', startedAt: 200 };
  const unknown = { id: 'legacy-unknown-turn' };
  assert.deepEqual(
    forkOwnTurns({ id: 'forked-thread', turns: [inherited, own, unknown] }, 150_000),
    [own, unknown],
  );
});

test('existing fork migration cleans inherited cards without backfilling old child turns', () => {
  const base = {
    created: false,
    transcriptVersion: 11,
    forkedFromThreadId: 'source-thread',
    forkTranscriptVersion: 0,
  };
  assert.equal(shouldCleanupOnlyExistingFork(base), true);
  assert.equal(shouldCleanupOnlyExistingFork({ ...base, created: true }), false);
  assert.equal(shouldCleanupOnlyExistingFork({ ...base, transcriptVersion: 10 }), false);
  assert.equal(shouldCleanupOnlyExistingFork({ ...base, forkTranscriptVersion: 1 }), false);
  assert.equal(shouldCleanupOnlyExistingFork({ ...base, forkedFromThreadId: null }), false);
});

test('session JSONL restores synthetic user item IDs around steer chronology', async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-session-order-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const sessionPath = path.join(directory, 'rollout.jsonl');
  const entries = [
    { type: 'turn_context', payload: { turn_id: 'turn-1' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', id: 'raw-user-1', content: [{ type: 'input_text', text: 'start' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', id: 'assistant-before', content: [{ type: 'output_text', text: 'working' }] } },
    { type: 'response_item', payload: { type: 'reasoning', id: 'reasoning-before', summary: [] } },
    { type: 'response_item', payload: { type: 'message', role: 'user', id: 'raw-user-2', content: [{ type: 'input_text', text: 'adjust' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', id: 'assistant-after', content: [{ type: 'output_text', text: 'adjusted' }] } },
    { type: 'turn_context', payload: { turn_id: 'turn-2' } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', id: 'outside-turn', content: [] } },
  ];
  fs.writeFileSync(sessionPath, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`, 'utf8');

  assert.deepEqual(
    await readSessionTurnCardOrder(sessionPath, 'turn-1', [
      { id: 'item-1', text: 'start' },
      { id: 'item-2', text: 'adjust' },
    ]),
    [
      { kind: 'user', id: 'item-1' },
      { kind: 'detail', id: 'assistant-before' },
      { kind: 'detail', id: 'reasoning-before' },
      { kind: 'user', id: 'item-2' },
      { kind: 'detail', id: 'assistant-after' },
    ],
  );
});

test('session-order repair targets only bot transcript cards for explicitly marked turns', () => {
  const message = (id, authorId, turnId, title = null) => ({
    id,
    author: { id: authorId },
    embeds: turnId ? [{ title, fields: [{ name: 'Turn', value: `\`${turnId}\`` }] }] : [],
  });
  const messages = new Map([
    ['repair-user', message('repair-user', 'bot', 'turn-repair')],
    ['repair-detail', message('repair-detail', 'bot', 'turn-repair')],
    ['keep-compaction', message(
      'keep-compaction',
      'bot',
      'turn-repair',
      'Codex context compacted',
    )],
    ['keep-turn', message('keep-turn', 'bot', 'turn-keep')],
    ['keep-human', message('keep-human', 'human', 'turn-repair')],
    ['keep-panel', message('keep-panel', 'bot', null)],
  ]);

  assert.deepEqual(
    sessionOrderRepairMessageIds(messages, ['turn-repair'], 'bot'),
    ['repair-user', 'repair-detail'],
  );
});

test('Codex notification floods coalesce content deltas and yield to Discord work', async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-notification-flood-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const stateStore = new StateStore(directory, 'guild-1');
  stateStore.setBinding('thread-1', {
    channelId: 'channel-1',
    name: 'Flood test',
    cwd: 'C:\\work',
    watchLevel: 'normal',
    archived: false,
  });

  const client = new EventEmitter();
  client.user = { id: 'bot-user' };
  const codex = new EventEmitter();
  const controller = new DiscordController({
    client,
    codex,
    stateStore,
    config: {
      authorizedUserIds: ['user-1'],
      liveUpdateIntervalMs: 60_000,
      elapsedUpdateIntervalMs: 60_000,
    },
    logDir: directory,
  });
  controller.attach();
  context.after(() => controller.stop());

  for (let index = 0; index < 20_000; index += 1) {
    codex.emit('notification', {
      method: 'item/commandExecution/outputDelta',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'command-1',
        delta: 'ignored',
      },
    });
  }
  assert.equal(controller.notificationQueues.size, 0);

  for (let index = 0; index < 10_000; index += 1) {
    codex.emit('notification', {
      method: 'item/agentMessage/delta',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'assistant-1',
        delta: 'x',
      },
    });
  }
  codex.emit('notification', {
    method: 'turn/plan/updated',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-1',
      plan: [{ step: 'after deltas', status: 'in_progress' }],
    },
  });

  assert.equal(controller.notificationBuffers.get('thread-1').entries.length, 2);
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (let attempt = 0; attempt < 100 && controller.notificationQueues.size; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  assert.equal(controller.notificationQueues.size, 0);
  const view = controller.turnViews.get('thread-1:turn-1');
  assert.equal(view.text, 'x'.repeat(10_000));
  assert.deepEqual(view.plan, [{ step: 'after deltas', status: 'in_progress' }]);
});

test('same-task Codex notifications stay serial while another task proceeds', async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-notification-serial-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const stateStore = new StateStore(directory, 'guild-1');
  stateStore.setBinding('thread-1', {
    channelId: 'channel-1',
    name: 'Serial notification test',
    cwd: 'C:\\work',
    watchLevel: 'normal',
    archived: false,
  });
  stateStore.setBinding('thread-2', {
    channelId: 'channel-2',
    name: 'Parallel notification test',
    cwd: 'C:\\work',
    watchLevel: 'normal',
    archived: false,
  });

  const client = new EventEmitter();
  client.user = { id: 'bot-user' };
  let markFetchStarted;
  let releaseFetch;
  let markSecondFetchStarted;
  const fetchStarted = new Promise((resolve) => { markFetchStarted = resolve; });
  const fetchRelease = new Promise((resolve) => { releaseFetch = resolve; });
  const secondFetchStarted = new Promise((resolve) => { markSecondFetchStarted = resolve; });
  client.channels = {
    fetch: async (channelId) => {
      if (channelId === 'channel-2') {
        markSecondFetchStarted();
        throw new Error('parallel test release');
      }
      markFetchStarted();
      await fetchRelease;
      throw new Error('test release');
    },
  };
  const codex = new EventEmitter();
  const controller = new DiscordController({
    client,
    codex,
    stateStore,
    config: {
      authorizedUserIds: ['user-1'],
      liveUpdateIntervalMs: 60_000,
      elapsedUpdateIntervalMs: 60_000,
    },
    logDir: directory,
  });
  controller.attach();
  context.after(() => controller.stop());

  codex.emit('notification', {
    method: 'turn/started',
    params: {
      threadId: 'thread-1',
      turn: { id: 'turn-1', status: 'inProgress', startedAt: Date.now() },
    },
  });
  await fetchStarted;
  codex.emit('notification', {
    method: 'turn/started',
    params: {
      threadId: 'thread-2',
      turn: { id: 'turn-2', status: 'inProgress', startedAt: Date.now() },
    },
  });
  assert.equal(await Promise.race([
    secondFetchStarted.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 100)),
  ]), true);
  codex.emit('notification', {
    method: 'item/agentMessage/delta',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'assistant-1',
      delta: 'ordered text',
    },
  });
  codex.emit('notification', {
    method: 'turn/plan/updated',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-1',
      plan: [{ step: 'ordered plan', status: 'in_progress' }],
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 20));

  const blockedBuffer = controller.notificationBuffers.get('thread-1');
  assert.equal(blockedBuffer.offset, 1);
  assert.equal(blockedBuffer.entries.length, 3);
  const blockedView = controller.turnViews.get('thread-1:turn-1');
  assert.equal(blockedView.text, '');
  assert.deepEqual(blockedView.plan, []);

  releaseFetch();
  for (let attempt = 0; attempt < 100 && controller.notificationQueues.size; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(controller.notificationQueues.size, 0);
  assert.equal(blockedView.text, 'ordered text');
  assert.deepEqual(blockedView.plan, [{ step: 'ordered plan', status: 'in_progress' }]);
});

test('live turn mutations remove duplicate cards and finish an in-flight render before completion', async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-context-compaction-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const stateStore = new StateStore(directory, 'guild-1');
  stateStore.setBinding('thread-1', {
    channelId: 'channel-1',
    name: 'Compaction task',
    cwd: 'C:\\work',
    sessionPath: path.join(directory, 'missing-session.jsonl'),
    watchLevel: 'normal',
    completionReportsEnabled: false,
    archived: false,
  });

  const client = new EventEmitter();
  client.user = { id: 'bot-user' };
  const codex = new EventEmitter();
  const messages = new Map();
  const sent = [];
  let nextMessageId = 1;
  let historyFetchCount = 0;
  let blockNextRunningEdit = false;
  let resolveRunningEditStarted;
  let releaseRunningEdit;
  const runningEditStarted = new Promise((resolve) => { resolveRunningEditStarted = resolve; });
  const runningEditRelease = new Promise((resolve) => { releaseRunningEdit = resolve; });
  const collection = () => Object.assign(new Map(messages), {
    last: () => [...messages.values()].at(-1) ?? null,
    find: (predicate) => [...messages.values()].find(predicate),
  });
  const makeMessage = (options) => {
    const message = {
      id: `message-${nextMessageId++}`,
      author: { id: 'bot-user', bot: true },
      content: options.content ?? '',
      embeds: (options.embeds ?? []).map((embed) => embed.toJSON?.() ?? embed),
      components: (options.components ?? []).map((component) => component.toJSON?.() ?? component),
      attachments: new Map(),
      pinned: false,
      edit: async (next) => {
        if (blockNextRunningEdit
          && (next.embeds?.[0]?.toJSON?.() ?? next.embeds?.[0])?.title === 'Codex running') {
          blockNextRunningEdit = false;
          resolveRunningEditStarted();
          await runningEditRelease;
        }
        message.content = next.content ?? message.content;
        if (next.embeds) message.embeds = next.embeds.map((embed) => embed.toJSON?.() ?? embed);
        if (next.components) message.components = next.components.map((component) => component.toJSON?.() ?? component);
        return message;
      },
      delete: async () => { messages.delete(message.id); },
    };
    messages.set(message.id, message);
    sent.push(message);
    return message;
  };
  const channel = {
    id: 'channel-1',
    messages: {
      fetch: async (value) => {
        if (typeof value === 'string') return messages.get(value) ?? null;
        historyFetchCount += 1;
        return collection();
      },
    },
    send: async (options) => makeMessage(options),
  };
  client.channels = { fetch: async () => channel };

  for (let index = 0; index < 2; index += 1) {
    makeMessage({
      embeds: [{
        title: 'Codex running',
        fields: [
          { name: 'Task', value: '`thread-1`' },
          { name: 'Turn', value: '`turn-1`' },
        ],
      }],
    });
  }

  const controller = new DiscordController({
    client,
    codex,
    stateStore,
    config: {
      authorizedUserIds: ['user-1'],
      liveUpdateIntervalMs: 5,
      elapsedUpdateIntervalMs: 60_000,
    },
    logDir: directory,
  });
  controller.attach();

  stateStore.setBinding('thread-1', { transcriptVersion: 11 });
  stateStore.setTurnRecord('thread-1', 'turn-1', {
    cardMessageId: 'message-2',
    liveMessageId: 'message-2',
    status: 'inProgress',
  });
  let releaseTranscriptTail;
  controller.transcriptSyncTail = new Promise((resolve) => { releaseTranscriptTail = resolve; });
  const restoredActiveThread = {
    id: 'thread-1',
    name: 'Compaction task',
    cwd: 'C:\\work',
    path: null,
    status: { type: 'active' },
    turns: [{ id: 'turn-1', status: 'inProgress', items: [] }],
  };
  codex.readThread = async () => ({ thread: restoredActiveThread });
  codex.emit('subscriptionRestored', {
    binding: stateStore.binding('thread-1'),
    thread: restoredActiveThread,
    runtime: {},
    missedCompletion: null,
  });
  for (let attempt = 0; attempt < 100
    && [...messages.values()].filter((message) => message.embeds[0]?.title === 'Codex running').length > 1;
    attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(
    [...messages.values()].filter((message) => message.embeds[0]?.title === 'Codex running').length,
    1,
  );
  assert.equal(controller.subscriptionSyncPromises.size, 1);
  releaseTranscriptTail();
  for (let attempt = 0; attempt < 200 && controller.subscriptionSyncPromises.size; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  const waitForNotifications = async () => {
    for (let attempt = 0; attempt < 100 && controller.notificationQueues.size; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(controller.notificationQueues.size, 0);
  };
  codex.emit('notification', {
    method: 'turn/started',
    params: {
      threadId: 'thread-1',
      turn: { id: 'turn-1', status: 'inProgress', startedAt: Date.now() },
    },
  });
  await waitForNotifications();

  const notification = {
    method: 'item/completed',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: { type: 'contextCompaction', id: 'compaction-1' },
    },
  };
  codex.emit('notification', notification);
  await waitForNotifications();

  const visibleTitles = [...messages.values()].map((message) => message.embeds[0]?.title);
  assert.deepEqual(visibleTitles, ['Codex context compacted', 'Codex running']);
  const compaction = [...messages.values()].find(
    (message) => message.embeds[0]?.title === 'Codex context compacted',
  );
  assert.equal(compaction.embeds[0].description, '会話履歴のコンテキストがコンパクト化されました。');
  assert.deepEqual(
    compaction.embeds[0].fields.map((field) => [field.name, field.value]),
    [
      ['Task', '`thread-1`'],
      ['Turn', '`turn-1`'],
      ['Item', '`compaction-1`'],
    ],
  );
  const firstRecord = stateStore.turnRecord('thread-1', 'turn-1');
  assert.equal(firstRecord.compactionEntries['compaction-1'].messageId, compaction.id);
  assert.match(firstRecord.compactionEntries['compaction-1'].completedAt, /^\d{4}-\d{2}-\d{2}T/);

  const sentCount = sent.length;
  codex.emit('notification', notification);
  await waitForNotifications();
  assert.equal(sent.length, sentCount);
  assert.equal(
    [...messages.values()].filter(
      (message) => message.embeds[0]?.title === 'Codex context compacted',
    ).length,
    1,
  );
  assert.equal(
    stateStore.turnRecord('thread-1', 'turn-1').compactionEntries['compaction-1'].messageId,
    compaction.id,
  );

  codex.emit('notification', {
    method: 'item/started',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: { type: 'agentMessage', id: 'assistant-1', phase: 'commentary', text: '' },
    },
  });
  await waitForNotifications();

  blockNextRunningEdit = true;
  codex.emit('notification', {
    method: 'item/agentMessage/delta',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'assistant-1',
      delta: 'Working while completion arrives.',
    },
  });
  await Promise.race([
    runningEditStarted,
    new Promise((_, reject) => setTimeout(() => reject(new Error('live render did not start')), 1_000)),
  ]);

  codex.emit('notification', {
    method: 'turn/completed',
    params: {
      threadId: 'thread-1',
      turn: {
        id: 'turn-1',
        status: 'completed',
        items: [
          {
            type: 'agentMessage',
            id: 'assistant-1',
            phase: 'commentary',
            text: 'Working while completion arrives.',
          },
          { type: 'agentMessage', id: 'final-1', phase: 'final_answer', text: 'Finished.' },
        ],
      },
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(stateStore.binding('thread-1').lastCompletedTurnId ?? null, null);
  releaseRunningEdit();
  for (let attempt = 0; attempt < 200
    && stateStore.binding('thread-1').lastCompletedTurnId !== 'turn-1'; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  assert.equal(stateStore.binding('thread-1').lastCompletedTurnId, 'turn-1');
  assert.equal(
    [...messages.values()].filter((message) => message.embeds[0]?.title === 'Codex running').length,
    0,
  );
  assert.equal(
    [...messages.values()].filter((message) => message.embeds[0]?.title === 'Codex turn completed').length,
    1,
  );
  assert.equal(stateStore.turnRecord('thread-1', 'turn-1').status, 'completed');

  codex.emit('notification', {
    method: 'turn/started',
    params: {
      threadId: 'thread-1',
      turn: { id: 'turn-2', status: 'inProgress', startedAt: Date.now() },
    },
  });
  await waitForNotifications();
  codex.emit('notification', {
    method: 'turn/completed',
    params: {
      threadId: 'thread-1',
      turn: {
        id: 'turn-2',
        status: 'completed',
        items: [
          { type: 'agentMessage', id: 'unseen-commentary', phase: 'commentary', text: 'Recovered before final.' },
          { type: 'agentMessage', id: 'final-2', phase: 'final_answer', text: 'Second finish.' },
        ],
      },
    },
  });
  for (let attempt = 0; attempt < 200
    && stateStore.binding('thread-1').lastCompletedTurnId !== 'turn-2'; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  const orderedTurnTwoCards = [...messages.values()]
    .filter((message) => message.embeds[0]?.fields?.some(
      (field) => field.name === 'Turn' && field.value === '`turn-2`',
    ));
  assert.deepEqual(
    orderedTurnTwoCards.map((message) => message.embeds[0].title),
    ['Codex message', 'Codex turn completed'],
  );

  codex.emit('notification', {
    method: 'turn/started',
    params: {
      threadId: 'thread-1',
      turn: { id: 'turn-3', status: 'inProgress', startedAt: Date.now() },
    },
  });
  await waitForNotifications();
  const historyFetchesBeforeCommentaryBoundaries = historyFetchCount;
  for (const itemId of ['empty-placeholder', 'stream-a']) {
    codex.emit('notification', {
      method: 'item/started',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-3',
        item: { id: itemId, type: 'agentMessage', phase: 'commentary', text: '' },
      },
    });
    await waitForNotifications();
  }
  for (const [itemId, delta] of [
    ['stream-a', 'First delta-only commentary.'],
    ['stream-b', 'Second delta-only commentary.'],
  ]) {
    codex.emit('notification', {
      method: 'item/agentMessage/delta',
      params: { threadId: 'thread-1', turnId: 'turn-3', itemId, delta },
    });
    await waitForNotifications();
  }
  await new Promise((resolve) => setTimeout(resolve, 30));
  const liveBeforeIndividualCompletions = [...messages.values()]
    .filter((message) => message.embeds[0]?.fields?.some(
      (field) => field.name === 'Turn' && field.value === '`turn-3`',
    ));
  assert.equal(
    liveBeforeIndividualCompletions.filter(
      (message) => message.embeds[0]?.title === 'Codex message',
    ).length,
    0,
  );
  assert.deepEqual(
    liveBeforeIndividualCompletions
      .filter((message) => message.embeds[0]?.title === 'Codex running')
      .map((message) => message.embeds[0].description),
    ['First delta-only commentary.'],
  );
  for (const [itemId, text] of [
    ['stream-a', 'First delta-only commentary.'],
    ['stream-b', 'Second delta-only commentary.'],
  ]) {
    codex.emit('notification', {
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-3',
        item: { id: itemId, type: 'agentMessage', phase: 'commentary', text },
      },
    });
    await waitForNotifications();
  }
  await new Promise((resolve) => setTimeout(resolve, 30));
  const liveAfterIndividualCompletions = [...messages.values()]
    .filter((message) => message.embeds[0]?.fields?.some(
      (field) => field.name === 'Turn' && field.value === '`turn-3`',
    ));
  assert.deepEqual(
    liveAfterIndividualCompletions.map((message) => [
      message.embeds[0].title,
      message.embeds[0].description,
    ]),
    [
      ['Codex message', 'First delta-only commentary.'],
      ['Codex running', 'Second delta-only commentary.'],
    ],
  );
  assert.equal(historyFetchCount, historyFetchesBeforeCommentaryBoundaries);
  const contaminated = makeMessage({
    embeds: [{
      title: 'Codex message',
      fields: [
        { name: 'Task', value: '`thread-1`' },
        { name: 'Turn', value: '`turn-3`' },
        { name: 'Message', value: '`stream-contaminated`' },
      ],
      description: 'First delta-only commentary.Second delta-only commentary.',
    }],
  });
  const contaminatedRecord = stateStore.turnRecord('thread-1', 'turn-3');
  stateStore.setTurnRecord('thread-1', 'turn-3', {
    assistantEntries: {
      ...contaminatedRecord.assistantEntries,
      'stream-contaminated': {
        text: 'First delta-only commentary.Second delta-only commentary.',
        phase: 'commentary',
        messageIds: [contaminated.id],
      },
    },
    assistantMessageIds: [...new Set([
      ...(contaminatedRecord.assistantMessageIds ?? []),
      contaminated.id,
    ])],
  });
  const stableTurnThree = {
    id: 'turn-3',
    status: 'completed',
    items: [
      { type: 'agentMessage', id: 'item-a', phase: 'commentary', text: 'First delta-only commentary.' },
      { type: 'agentMessage', id: 'item-b', phase: 'commentary', text: 'Second delta-only commentary.' },
      { type: 'agentMessage', id: 'final-3', phase: 'final_answer', text: 'Third finish.' },
    ],
  };
  codex.emit('notification', {
    method: 'turn/completed',
    params: { threadId: 'thread-1', turn: stableTurnThree },
  });
  for (let attempt = 0; attempt < 200
    && stateStore.binding('thread-1').lastCompletedTurnId !== 'turn-3'; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const orderedTurnThreeCards = [...messages.values()]
    .filter((message) => message.embeds[0]?.fields?.some(
      (field) => field.name === 'Turn' && field.value === '`turn-3`',
    ));
  assert.deepEqual(
    orderedTurnThreeCards.map((message) => message.embeds[0].title),
    ['Codex message', 'Codex message', 'Codex turn completed'],
  );
  assert.deepEqual(
    orderedTurnThreeCards.slice(0, 2).map((message) => message.embeds[0].fields
      .find((field) => field.name === 'Message').value),
    ['`item-a`', '`item-b`'],
  );
  assert.deepEqual(
    Object.keys(stateStore.turnRecord('thread-1', 'turn-3').assistantEntries).sort(),
    ['item-a', 'item-b'],
  );

  const staleActiveThread = {
    id: 'thread-1',
    name: 'Compaction task',
    cwd: 'C:\\work',
    path: null,
    status: { type: 'active' },
    turns: [{ id: 'turn-2', status: 'inProgress', items: [] }],
  };
  codex.readThread = async () => ({ thread: staleActiveThread });
  codex.emit('subscriptionRestored', {
    binding: stateStore.binding('thread-1'),
    thread: staleActiveThread,
    runtime: {},
    missedCompletion: null,
  });
  for (let attempt = 0; attempt < 200 && controller.subscriptionSyncPromises.size; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(
    [...messages.values()].filter((message) => message.embeds[0]?.title === 'Codex running').length,
    0,
  );

  const startupContaminated = makeMessage({
    embeds: [{
      title: 'Codex message',
      fields: [
        { name: 'Task', value: '`thread-1`' },
        { name: 'Turn', value: '`turn-3`' },
        { name: 'Message', value: '`stream-after-restart`' },
      ],
      description: 'Superseded after restart.',
    }],
  });
  const beforeStartupRepair = stateStore.turnRecord('thread-1', 'turn-3');
  stateStore.setTurnRecord('thread-1', 'turn-3', {
    assistantEntries: {
      ...beforeStartupRepair.assistantEntries,
      'stream-after-restart': {
        text: 'Superseded after restart.',
        phase: 'commentary',
        messageIds: [startupContaminated.id],
      },
    },
    assistantMessageIds: [...new Set([
      ...(beforeStartupRepair.assistantMessageIds ?? []),
      startupContaminated.id,
    ])],
  });
  const idleThread = {
    id: 'thread-1',
    name: 'Compaction task',
    cwd: 'C:\\work',
    path: null,
    status: { type: 'idle' },
    turns: [stableTurnThree],
  };
  codex.emit('subscriptionRestored', {
    binding: stateStore.binding('thread-1'),
    thread: idleThread,
    runtime: {},
    missedCompletion: null,
  });
  for (let attempt = 0; attempt < 200 && controller.subscriptionSyncPromises.size; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(messages.has(startupContaminated.id), false);
  assert.equal(
    stateStore.turnRecord('thread-1', 'turn-3').assistantEntries['stream-after-restart'],
    undefined,
  );
  await controller.stop();
});

test('live notifications wait behind the transcript repair for the same task', async () => {
  let releaseRepair;
  const repair = new Promise((resolve) => { releaseRepair = resolve; });
  const events = [];
  const pending = runAfterTranscriptBarrier(
    new Map([['thread-1', repair]]),
    'thread-1',
    () => events.push('notification'),
  );
  await Promise.resolve();
  assert.deepEqual(events, []);
  releaseRepair();
  await pending;
  assert.deepEqual(events, ['notification']);
});

test('stable user cards retire empty provisional entries for the same steer text', () => {
  const entries = {
    'provisional-steer': { text: 'adjust', messageIds: [], source: 'Discord' },
    'item-steer': { text: 'adjust', messageIds: ['card-1'], source: null },
    'provisional-other': { text: 'other', messageIds: [], source: 'Discord' },
    'posted-duplicate': { text: 'adjust', messageIds: ['card-2'], source: 'Discord' },
  };
  assert.deepEqual(
    emptyDuplicateUserEntryIds(entries, { id: 'item-steer', text: 'adjust' }),
    ['provisional-steer'],
  );
});

test('subagent descriptors preserve stable parent identity and flatten a readable Discord name', () => {
  const child = {
    id: '019fe224-d88a-7b60-a9f0-e6a744ceb422',
    parentThreadId: 'parent-thread',
    status: { type: 'active' },
    source: {
      subAgent: {
        thread_spawn: {
          parent_thread_id: 'parent-thread',
          depth: 2,
          agent_path: '/root/local_gap_audit',
          agent_nickname: 'Pasteur',
        },
      },
    },
  };
  assert.equal(isSubagentCodexThread(child), true);
  assert.equal(isActiveSubagentThread(child), true);
  assert.equal(isActiveSubagentThread({ ...child, status: { type: 'idle' } }), false);
  assert.equal(isSubagentCodexThread({ ...child, ephemeral: true }), false);
  assert.deepEqual(subagentMetadata(child), {
    parentThreadId: 'parent-thread',
    depth: 2,
    agentPath: '/root/local_gap_audit',
    nickname: 'Pasteur',
    role: null,
  });
  assert.equal(subagentDiscordThreadName(child), '🟢 Pasteur · local-gap-audit · 44ceb422');
  assert.deepEqual(subagentIdsFromThread({
    turns: [{
      items: [
        { type: 'subAgentActivity', agentThreadId: child.id },
        { type: 'collabAgentToolCall', receiverThreadIds: [child.id, 'nested-child'] },
      ],
    }],
  }), [child.id, 'nested-child']);
  assert.deepEqual(subagentOwnTurns({
    ...child,
    turns: [
      { id: '019fe224-17f3-7533-b896-cbb51f975224', completedAt: '2099-01-01T00:00:00Z' },
      { id: '019fe224-dc15-7f81-adbe-1060f31756bc' },
      { id: '019fe225-0000-7000-8000-000000000000' },
    ],
  }).map((turn) => turn.id), [
    '019fe224-dc15-7f81-adbe-1060f31756bc',
    '019fe225-0000-7000-8000-000000000000',
  ]);
});

test('periodic subagent sync excludes completed and unloaded bindings', () => {
  assert.equal(shouldPeriodicallySyncSubagent(null), true);
  assert.equal(shouldPeriodicallySyncSubagent({ taskStatus: 'active', discordArchived: false }), true);
  assert.equal(shouldPeriodicallySyncSubagent({ taskStatus: 'idle', discordArchived: false }), false);
  assert.equal(shouldPeriodicallySyncSubagent({ taskStatus: 'notLoaded', discordArchived: false }), false);
  assert.equal(shouldPeriodicallySyncSubagent({ taskStatus: 'unknown', discordArchived: false }), true);
  assert.equal(shouldPeriodicallySyncSubagent({ taskStatus: 'unknown', discordArchived: true }), false);
});

test('an unknown live subagent notification creates an isolated Discord thread mirror', async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-subagent-thread-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const stateStore = new StateStore(directory, 'guild-1');
  stateStore.setBinding('parent-thread', {
    channelId: 'parent-channel',
    cwd: 'C:\\work',
    archived: false,
  });

  const client = new EventEmitter();
  client.user = { id: 'bot-user' };
  const codex = new EventEmitter();
  const childThread = {
    id: '019fe224-d88a-7b60-a9f0-e6a744ceb422',
    parentThreadId: 'parent-thread',
    status: { type: 'active' },
    cwd: 'C:\\work',
    turns: [
      { id: '019fe224-17f3-7533-b896-cbb51f975224', status: 'completed', items: [] },
      { id: '019fe224-dc15-7f81-adbe-1060f31756bc', status: 'inProgress', items: [] },
    ],
    source: {
      subAgent: {
        thread_spawn: {
          parent_thread_id: 'parent-thread',
          depth: 1,
          agent_path: '/root/local_gap_audit',
          agent_nickname: 'Pasteur',
        },
      },
    },
  };
  codex.readThread = async (threadId) => {
    assert.equal(threadId, childThread.id);
    return { thread: structuredClone(childThread) };
  };

  const messages = new Map();
  const collection = () => {
    const value = new Map(messages);
    value.last = () => [...value.values()].at(-1) ?? null;
    return value;
  };
  let nextMessageId = 1;
  let bulkDeleted = [];
  const discordThread = {
    id: 'discord-subagent-thread',
    parentId: 'parent-channel',
    name: 'temporary',
    archived: false,
    isThread: () => true,
    setArchived: async (archived) => { discordThread.archived = archived; return discordThread; },
    setName: async (name) => { discordThread.name = name; return discordThread; },
    bulkDelete: async (ids) => {
      bulkDeleted = [...ids];
      const deleted = new Map();
      for (const id of ids) {
        const message = messages.get(id);
        if (message) deleted.set(id, message);
        messages.delete(id);
      }
      return deleted;
    },
    messages: {
      fetch: async (value) => (typeof value === 'string' ? messages.get(value) ?? null : collection()),
    },
    send: async (payload) => {
      const message = {
        id: `message-${nextMessageId++}`,
        author: { id: 'bot-user', bot: true },
        content: payload.content ?? '',
        embeds: (payload.embeds ?? []).map((embed) => embed.toJSON?.() ?? embed),
        components: payload.components ?? [],
        attachments: new Map(),
        edit: async (next) => {
          message.content = next.content ?? message.content;
          if (next.embeds) message.embeds = next.embeds.map((embed) => embed.toJSON?.() ?? embed);
          message.components = next.components ?? message.components;
          return message;
        },
        delete: async () => messages.delete(message.id),
      };
      messages.set(message.id, message);
      return message;
    },
  };
  const parentChannel = {
    id: 'parent-channel',
    threads: {
      fetchActive: async () => ({ threads: new Map() }),
      fetchArchived: async () => ({ threads: new Map() }),
      create: async () => discordThread,
    },
  };
  client.channels = {
    fetch: async (channelId) => ({
      'parent-channel': parentChannel,
      'discord-subagent-thread': discordThread,
    })[channelId] ?? null,
  };
  messages.set('inherited-card-1', {
    id: 'inherited-card-1',
    author: { id: 'bot-user', bot: true },
    content: '',
    embeds: [{
      title: 'Codex turn completed',
      fields: [
        { name: 'Task', value: `\`${childThread.id}\`` },
        { name: 'Turn', value: '`019fe224-17f3-7533-b896-cbb51f975224`' },
      ],
    }],
    components: [],
    attachments: new Map(),
    delete: async () => messages.delete('inherited-card-1'),
  });
  messages.set('inherited-card-2', {
    ...messages.get('inherited-card-1'),
    id: 'inherited-card-2',
    delete: async () => messages.delete('inherited-card-2'),
  });

  const controller = new DiscordController({
    client,
    codex,
    stateStore,
    config: { liveUpdateIntervalMs: 1, elapsedUpdateIntervalMs: 60_000 },
    logDir: directory,
  });
  controller.attach();
  codex.emit('notification', {
    method: 'thread/status/changed',
    params: { threadId: childThread.id },
  });
  for (let attempt = 0; attempt < 100 && !stateStore.subagentThread(childThread.id); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  for (let attempt = 0; attempt < 100 && bulkDeleted.length < 2; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  const binding = stateStore.subagentThread(childThread.id);
  const diagnosticLog = fs.readdirSync(directory)
    .filter((name) => name.startsWith('discord-') && name.endsWith('.jsonl'))
    .map((name) => fs.readFileSync(path.join(directory, name), 'utf8'))
    .join('\n');
  assert.ok(binding, diagnosticLog || 'subagent binding was not created');
  assert.equal(binding.channelId, discordThread.id);
  assert.equal(binding.topLevelParentThreadId, 'parent-thread');
  assert.equal(stateStore.bindings().length, 1);
  assert.equal(stateStore.bindingByChannel(discordThread.id), null);
  assert.equal(discordThread.name, '🟢 Pasteur · local-gap-audit · 44ceb422');
  assert.ok([...messages.values()].some((message) => message.embeds[0]?.title === 'Codex subagent'));
  assert.deepEqual(bulkDeleted.sort(), ['inherited-card-1', 'inherited-card-2']);
  assert.deepEqual(Object.keys(stateStore.subagentThread(childThread.id).turnMessages), [
    '019fe224-dc15-7f81-adbe-1060f31756bc',
  ]);

  codex.emit('notification', {
    method: 'turn/started',
    params: { threadId: childThread.id, turn: { id: 'child-turn', status: 'inProgress' } },
  });
  for (let attempt = 0; attempt < 100
    && ![...messages.values()].some((message) => message.embeds[0]?.title === 'Codex running'); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok([...messages.values()].some((message) => message.embeds[0]?.title === 'Codex running'));
  await controller.stop();
});

test('completion recovery targets only a newer live record or a broken latest completion card', () => {
  assert.equal(completionRecoveryCandidate({
    lastCompletedTurnId: '019fa200',
    turnMessages: {
      '019f9500': { status: 'inProgress' },
      '019fa200': { status: 'completed', cardMessageId: 'card', finalMessageIds: ['card'] },
    },
  }), null);
  assert.equal(completionRecoveryCandidate({
    lastCompletedTurnId: '019fa200',
    turnMessages: {
      '019fa200': { status: 'completed', cardMessageId: 'card', finalMessageIds: ['card'] },
      '019fa300': { status: 'inProgress' },
    },
  }), '019fa300');
  assert.equal(completionRecoveryCandidate({
    lastCompletedTurnId: '019fa200',
    turnMessages: {
      '019fa200': { status: 'completed', cardMessageId: null, finalMessageIds: ['commentary'] },
    },
  }), '019fa200');
});

test('controller shutdown clears polling and recovery timers before Discord closes', async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-controller-stop-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const client = new EventEmitter();
  const codex = new EventEmitter();
  const controller = new DiscordController({
    client,
    codex,
    stateStore: { snapshot: () => ({ infrastructure: {} }) },
    config: {},
    logDir: directory,
  });
  controller.taskSyncTimer = setInterval(() => {}, 60_000);
  controller.taskSyncInitialTimer = setTimeout(() => {}, 60_000);
  controller.taskSyncDebounceTimer = setTimeout(() => {}, 60_000);
  controller.turnViews.set('thread:turn', {
    timer: setTimeout(() => {}, 60_000),
    elapsedTimer: setTimeout(() => {}, 60_000),
  });
  const recoveryTimer = setTimeout(() => {}, 60_000);
  controller.completionRecoveryJobs.set('thread:turn', { timer: recoveryTimer });

  await controller.stop();

  assert.equal(controller.stopping, true);
  assert.equal(controller.taskSyncTimer, null);
  assert.equal(controller.taskSyncInitialTimer, null);
  assert.equal(controller.taskSyncDebounceTimer, null);
  assert.equal(controller.turnViews.get('thread:turn').timer, null);
  assert.equal(controller.turnViews.get('thread:turn').elapsedTimer, null);
  assert.equal(controller.completionRecoveryJobs.size, 0);
});

test('controller shutdown waits up to five minutes in production and reports a stuck operation', async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-controller-stop-timeout-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const controller = new DiscordController({
    client: new EventEmitter(),
    codex: new EventEmitter(),
    stateStore: { snapshot: () => ({ infrastructure: {} }) },
    config: { controllerShutdownTimeoutMs: 5 },
    logDir: directory,
  });
  controller.taskSyncPromise = new Promise(() => {});

  const result = await controller.stop();

  assert.equal(result.timedOut, true);
  assert.deepEqual(result.pending, ['task-sync']);
});

test('controller shutdown waits for subscription restore work and ignores restores after stopping', async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-controller-subscription-stop-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const codex = new EventEmitter();
  const controller = new DiscordController({
    client: new EventEmitter(),
    codex,
    stateStore: { snapshot: () => ({ infrastructure: {} }) },
    config: {},
    logDir: directory,
  });
  controller.attach();
  let release;
  const subscriptionWork = new Promise((resolve) => {
    release = resolve;
  });
  controller.subscriptionSyncPromises.set('thread-1', subscriptionWork);

  let stopped = false;
  const stopping = controller.stop().then(() => {
    stopped = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, false);

  release();
  await stopping;
  controller.subscriptionSyncPromises.delete('thread-1');
  codex.emit('subscriptionRestored', {
    binding: { threadId: 'thread-after-stop' },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(controller.subscriptionSyncPromises.size, 0);
});

test('control panel recent history button opens a maximum seven-day selector and confirms the chosen window', async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-recent-history-ui-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const client = new EventEmitter();
  client.user = { id: 'bot-user' };
  const codex = new EventEmitter();
  const stateStore = {
    snapshot: () => ({ infrastructure: { controlChannelId: 'control-channel' } }),
  };
  const controller = new DiscordController({
    client,
    codex,
    stateStore,
    config: { guildId: 'guild-1', authorizedUserIds: ['user-1'] },
    logDir: directory,
  });
  controller.attach();

  const interaction = (customId, select = false, values = []) => ({
    guildId: 'guild-1',
    channelId: 'control-channel',
    user: { id: 'user-1' },
    customId,
    values,
    deferred: false,
    replied: false,
    isAutocomplete: () => false,
    isChatInputCommand: () => false,
    isStringSelectMenu: () => select,
    isButton: () => !select,
    isModalSubmit: () => false,
    isRepliable: () => true,
    deferUpdate: async function deferUpdate() { this.deferred = true; },
    editReply: async function editReply(payload) { this.lastReply = payload; return payload; },
    reply: async function reply(payload) { this.replied = true; this.lastReply = payload; return payload; },
  });
  const emit = async (value) => {
    client.emit('interactionCreate', value);
    for (let attempt = 0; attempt < 100 && !value.lastReply; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(value.lastReply);
    return value.lastReply;
  };

  const opened = await emit(interaction('cx:ui:control:recent-history'));
  const selector = opened.components[0].toJSON().components[0];
  assert.deepEqual(selector.options.map((option) => option.value), ['1', '3', '7']);

  const confirmation = await emit(interaction('cx:ui:control:recent-history-days', true, ['7']));
  assert.match(confirmation.content, /過去 \*\*7日\*\*/);
  assert.match(confirmation.content, /推論要約/);
  assert.match(confirmation.components[0].toJSON().components[0].custom_id, /^cx:confirm:[^:]+:yes$/);
});

test('control panel project selector requires confirmation before deleting a Discord mirror', async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-project-visibility-ui-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const client = new EventEmitter();
  client.user = { id: 'bot-user' };
  const codex = new EventEmitter();
  const stateStore = new StateStore(directory, 'guild-1');
  stateStore.setInfrastructure({ controlChannelId: 'control-channel' });
  stateStore.setProjectCategory('c:\\git\\visible', {
    projectId: 'prj_visible',
    path: 'C:\\git\\visible',
    name: 'Codex - visible',
    categoryIds: ['project-category'],
  });
  stateStore.setBinding('thread-1', {
    channelId: 'task-channel',
    projectKey: 'c:\\git\\visible',
    projectId: 'prj_visible',
    cwd: 'C:\\git\\visible',
    archived: false,
  });
  const controller = new DiscordController({
    client,
    codex,
    stateStore,
    config: { guildId: 'guild-1', authorizedUserIds: ['user-1'], projectCategoryPrefix: 'Codex - ' },
    logDir: directory,
  });
  controller.attach();

  const interaction = (customId, select = false, values = []) => ({
    guildId: 'guild-1',
    channelId: 'control-channel',
    user: { id: 'user-1' },
    customId,
    values,
    deferred: false,
    replied: false,
    isAutocomplete: () => false,
    isChatInputCommand: () => false,
    isStringSelectMenu: () => select,
    isButton: () => !select,
    isModalSubmit: () => false,
    isRepliable: () => true,
    deferUpdate: async function deferUpdate() { this.deferred = true; },
    editReply: async function editReply(payload) { this.lastReply = payload; return payload; },
    reply: async function reply(payload) { this.replied = true; this.lastReply = payload; return payload; },
  });
  const emit = async (value) => {
    client.emit('interactionCreate', value);
    for (let attempt = 0; attempt < 100 && !value.lastReply; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(value.lastReply);
    return value.lastReply;
  };

  const opened = await emit(interaction('cx:ui:control:projects'));
  assert.equal(opened.ephemeral, true);
  const select = opened.components[0].toJSON().components[0];
  assert.match(select.custom_id, /^cx:projects:[^:]+:select$/);
  assert.match(select.options[0].label, /非表示/);

  const confirmation = await emit(interaction(select.custom_id, true, ['0']));
  assert.match(confirmation.content, /Discordカテゴリ/);
  assert.match(confirmation.content, /Codexのtask\/threadとローカルファイルは削除しません/);
  assert.match(confirmation.components[0].toJSON().components[0].custom_id, /^cx:confirm:[^:]+:yes$/);
  assert.equal(stateStore.hiddenProjects().length, 0);
});

test('task sync deletes active and archived Discord mirrors for a hidden project', async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hidden-project-sync-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const desktopStatePath = path.join(directory, '.codex-global-state.json');
  const hiddenProjectId = 'local-hidden';
  fs.writeFileSync(desktopStatePath, JSON.stringify({
    'local-projects': {
      [hiddenProjectId]: {
        id: hiddenProjectId,
        name: 'hidden-project',
        rootPaths: ['C:\\git\\hidden-runs'],
      },
    },
    'thread-project-assignments': {},
  }));
  const stateStore = new StateStore(directory, 'guild-1');
  stateStore.setInfrastructure({
    controlCategoryId: 'control-category',
    controlChannelId: 'control-channel',
    completionsChannelId: 'completions-channel',
    archiveCategoryIds: ['archive-category'],
  });
  stateStore.setProjectCategory(hiddenProjectId, {
    projectId: hiddenProjectId,
    path: 'C:\\git\\hidden-runs',
    name: 'Codex - hidden-project',
    categoryIds: ['project-category'],
  });
  stateStore.setBinding('thread-hidden', {
    channelId: 'task-channel',
    categoryId: 'project-category',
    projectKey: hiddenProjectId,
    projectId: hiddenProjectId,
    cwd: 'C:\\git\\hidden-runs\\RUN-OLD\\scratch\\workspace',
    name: 'Hidden task',
    archived: false,
    taskStatus: 'idle',
  });
  stateStore.setTurnRecord('thread-hidden', 'turn-1', {
    completionNoticeMessageId: 'notice-1',
    finalMessageIds: ['final-1'],
  });
  stateStore.setBinding('thread-hidden-archived', {
    channelId: 'archived-task-channel',
    categoryId: 'archive-category',
    projectKey: hiddenProjectId,
    projectId: hiddenProjectId,
    cwd: 'C:\\detached-scratch\\RUN-OLD\\workspace',
    name: 'Archived hidden task',
    archived: true,
    taskStatus: 'idle',
  });
  stateStore.setTurnRecord('thread-hidden-archived', 'turn-2', {
    completionNoticeMessageId: 'notice-2',
    finalMessageIds: ['final-2'],
  });
  stateStore.setHiddenProject(hiddenProjectId, {
    projectId: hiddenProjectId,
    path: 'C:\\git\\hidden-runs',
    name: 'Codex - hidden-project',
  });

  const client = new EventEmitter();
  client.user = { id: 'bot-user', tag: 'bot#0001' };
  const codex = new EventEmitter();
  codex.connected = true;
  const codexThreads = [{
    id: 'thread-hidden',
    cwd: 'C:\\git\\hidden-runs\\RUN-NEW\\scratch\\workspace',
    name: 'Hidden task',
    status: { type: 'idle' },
    turns: [],
  }];
  const archivedCodexThreads = [{
    id: 'thread-hidden-archived',
    cwd: 'C:\\detached-scratch\\RUN-NEW\\workspace',
    name: 'Archived hidden task',
    status: { type: 'idle' },
    turns: [],
  }];
  codex.listAllThreads = async ({ archived }) => structuredClone(archived ? archivedCodexThreads : codexThreads);

  const channels = new Map();
  const categoryChildren = new Map();
  let taskDeleted = false;
  let archivedTaskDeleted = false;
  let categoryDeleted = false;
  const taskChannel = {
    id: 'task-channel',
    type: ChannelType.GuildText,
    parentId: 'project-category',
    topic: 'Codex task: thread-hidden',
    delete: async () => {
      taskDeleted = true;
      channels.delete('task-channel');
      categoryChildren.delete('task-channel');
    },
  };
  const projectCategory = {
    id: 'project-category',
    type: ChannelType.GuildCategory,
    name: 'Codex - hidden-project',
    children: { cache: categoryChildren },
    delete: async () => {
      categoryDeleted = true;
      channels.delete('project-category');
    },
  };
  const archiveChildren = new Map();
  const archivedTaskChannel = {
    id: 'archived-task-channel',
    type: ChannelType.GuildText,
    parentId: 'archive-category',
    topic: 'Codex task: thread-hidden-archived',
    delete: async () => {
      archivedTaskDeleted = true;
      channels.delete('archived-task-channel');
      archiveChildren.delete('archived-task-channel');
    },
  };
  const archiveCategory = {
    id: 'archive-category',
    type: ChannelType.GuildCategory,
    name: 'Codex Archived',
    children: { cache: archiveChildren },
  };
  categoryChildren.set(taskChannel.id, taskChannel);
  archiveChildren.set(archivedTaskChannel.id, archivedTaskChannel);
  const controlCategory = {
    id: 'control-category',
    type: ChannelType.GuildCategory,
    name: 'Codex Control',
    children: { cache: new Map() },
  };
  const completionMessages = new Map();
  let noticeDeleted = false;
  const notice = {
    id: 'notice-1',
    author: { id: 'bot-user' },
    content: 'https://discord.com/channels/guild-1/task-channel/final-1',
    delete: async () => {
      noticeDeleted = true;
      completionMessages.delete('notice-1');
    },
  };
  completionMessages.set(notice.id, notice);
  let archivedNoticeDeleted = false;
  const archivedNotice = {
    id: 'notice-2',
    author: { id: 'bot-user' },
    content: 'https://discord.com/channels/guild-1/archived-task-channel/final-2',
    delete: async () => {
      archivedNoticeDeleted = true;
      completionMessages.delete('notice-2');
    },
  };
  completionMessages.set(archivedNotice.id, archivedNotice);
  const discordCollection = (source) => Object.assign(new Map(source), {
    find: (predicate) => [...source.values()].find(predicate),
    last: () => [...source.values()].at(-1) ?? null,
  });
  const completions = {
    id: 'completions-channel',
    type: ChannelType.GuildText,
    messages: {
      fetch: async (value) => (typeof value === 'string'
        ? completionMessages.get(value) ?? null
        : discordCollection(completionMessages)),
    },
  };
  const controlMessages = new Map();
  const control = {
    id: 'control-channel',
    type: ChannelType.GuildText,
    messages: {
      fetch: async (value) => (typeof value === 'string'
        ? controlMessages.get(value) ?? null
        : discordCollection(controlMessages)),
    },
    send: async (payload) => {
      const message = {
        id: `control-message-${controlMessages.size + 1}`,
        author: { id: 'bot-user' },
        content: payload.content ?? '',
        embeds: (payload.embeds ?? []).map((embed) => embed.toJSON?.() ?? embed),
        components: (payload.components ?? []).map((component) => component.toJSON?.() ?? component),
        pinned: false,
        edit: async () => message,
      };
      controlMessages.set(message.id, message);
      return message;
    },
  };
  channels.set(controlCategory.id, controlCategory);
  channels.set(control.id, control);
  channels.set(completions.id, completions);
  channels.set(projectCategory.id, projectCategory);
  channels.set(taskChannel.id, taskChannel);
  channels.set(archiveCategory.id, archiveCategory);
  channels.set(archivedTaskChannel.id, archivedTaskChannel);
  const guild = {
    channels: {
      fetch: async () => discordCollection(channels),
    },
  };
  client.channels = { fetch: async (channelId) => channels.get(channelId) ?? null };

  const controller = new DiscordController({
    client,
    codex,
    stateStore,
    config: {
      guildId: 'guild-1',
      authorizedUserIds: ['user-1'],
      projectCategoryPrefix: 'Codex - ',
      defaultWatchLevel: 'normal',
      desktopGlobalStatePath: desktopStatePath,
    },
    logDir: directory,
  });
  controller.infrastructureReady = Promise.resolve({ guild, controlCategory, control, completions });
  controller.attach();
  const interaction = {
    guildId: 'guild-1',
    channelId: 'control-channel',
    user: { id: 'user-1' },
    customId: 'cx:ui:control:sync',
    deferred: false,
    replied: false,
    isAutocomplete: () => false,
    isChatInputCommand: () => false,
    isStringSelectMenu: () => false,
    isButton: () => true,
    isModalSubmit: () => false,
    isRepliable: () => true,
    deferReply: async function deferReply() { this.deferred = true; },
    editReply: async function editReply(payload) { this.lastReply = payload; return payload; },
  };
  client.emit('interactionCreate', interaction);
  for (let attempt = 0; attempt < 200 && !interaction.lastReply; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  assert.match(interaction.lastReply, /Discord削除 3/);
  assert.equal(taskDeleted, true);
  assert.equal(archivedTaskDeleted, true);
  assert.equal(categoryDeleted, true);
  assert.equal(noticeDeleted, true);
  assert.equal(archivedNoticeDeleted, true);
  assert.deepEqual(codexThreads.map((thread) => thread.id), ['thread-hidden']);
  assert.deepEqual(archivedCodexThreads.map((thread) => thread.id), ['thread-hidden-archived']);
  assert.equal(stateStore.binding('thread-hidden').hidden, true);
  assert.equal(stateStore.binding('thread-hidden').channelId, null);
  assert.equal(stateStore.binding('thread-hidden-archived').hidden, true);
  assert.equal(stateStore.binding('thread-hidden-archived').archived, true);
  assert.equal(stateStore.binding('thread-hidden-archived').channelId, null);
  assert.equal(stateStore.binding('thread-hidden-archived').projectKey, hiddenProjectId);
  assert.equal(stateStore.projectCategory(hiddenProjectId), null);

  const settledState = fs.readFileSync(stateStore.filePath, 'utf8');
  const repeatInteraction = {
    ...interaction,
    deferred: false,
    replied: false,
    lastReply: null,
  };
  client.emit('interactionCreate', repeatInteraction);
  for (let attempt = 0; attempt < 200 && !repeatInteraction.lastReply; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.match(repeatInteraction.lastReply, /Discord削除 0/);
  assert.equal(fs.readFileSync(stateStore.filePath, 'utf8'), settledState);
});

test('completed turns retry transient delivery failure, do not backfill commentary after finalization, and replace the unpinned task panel exactly once', async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-panel-repost-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const client = new EventEmitter();
  client.user = { id: 'bot-user' };
  const codex = new EventEmitter();
  codex.threadMetadata = async () => ({ thread: { path: null } });
  codex.readThread = async () => ({
    thread: {
      turns: [{
        id: 'turn-complete',
        status: 'completed',
        items: [
          { type: 'userMessage', id: 'persisted-user', content: [{ type: 'text', text: 'Do the work.' }] },
          { type: 'agentMessage', id: 'persisted-commentary', phase: 'commentary', text: 'Working.' },
          { type: 'agentMessage', id: 'final-1', phase: 'final_answer', text: 'Finished.' },
        ],
      }],
    },
  });
  const binding = {
    threadId: 'thread-panel',
    channelId: 'task-channel',
    name: 'Panel task',
    cwd: 'C:\\work',
    watchLevel: 'normal',
    completionReportsEnabled: true,
    archived: false,
    taskStatus: 'active',
    controlPanelMessageId: 'panel-old',
    lastPanelCompletionTurnId: null,
    turnMessages: {},
  };
  const stateStore = {
    binding: (threadId) => (threadId === binding.threadId ? structuredClone(binding) : null),
    turnRecord: (threadId, turnId) => binding.turnMessages[turnId] ? structuredClone(binding.turnMessages[turnId]) : null,
    setTurnRecord: (threadId, turnId, patch) => {
      binding.turnMessages[turnId] = { ...binding.turnMessages[turnId], ...patch };
    },
    setBinding: (threadId, patch) => { Object.assign(binding, patch); },
  };

  const channelMessages = new Map();
  const sent = [];
  let nextMessage = 1;
  const collection = (source) => Object.assign(new Map(source), {
    last: () => [...source.values()].at(-1) ?? null,
    find: (predicate) => [...source.values()].find(predicate),
  });
  const makeMessage = (id, options) => {
    const message = {
      id,
      url: `https://discord.test/channels/guild/task-channel/${id}`,
      author: { id: 'bot-user', bot: true },
      content: options.content ?? '',
      embeds: (options.embeds ?? []).map((embed) => embed.toJSON?.() ?? embed),
      components: (options.components ?? []).map((component) => component.toJSON?.() ?? component),
      attachments: new Map(),
      pinned: false,
      edit: async (next) => {
        message.content = next.content ?? message.content;
        if (next.embeds) message.embeds = next.embeds.map((embed) => embed.toJSON?.() ?? embed);
        if (next.components) message.components = next.components.map((component) => component.toJSON?.() ?? component);
        return message;
      },
      pin: async () => { message.pinned = true; return message; },
      unpin: async () => { message.pinned = false; return message; },
      delete: async () => { channelMessages.delete(message.id); },
    };
    channelMessages.set(id, message);
    return message;
  };
  const oldPanel = makeMessage('panel-old', {
    embeds: [{ footer: { text: taskPanelMarker(binding.threadId) } }],
  });
  oldPanel.pinned = true;
  const liveCommentary = makeMessage('assistant-live', {
    embeds: [{
      title: 'Codex message',
      description: 'Working.',
      fields: [
        { name: 'Task', value: `\`${binding.threadId}\`` },
        { name: 'Turn', value: '`turn-complete`' },
        { name: 'Message', value: '`live-commentary`' },
      ],
    }],
  });
  binding.turnMessages['turn-complete'] = {
    executorUserIds: ['executor-user'],
    assistantEntries: {
      'live-commentary': {
        text: 'Working.',
        phase: 'commentary',
        messageIds: [liveCommentary.id],
        localFiles: [],
      },
    },
    assistantMessageIds: [liveCommentary.id],
  };
  const channel = {
    id: 'task-channel',
    messages: {
      fetch: async (value) => (typeof value === 'string'
        ? channelMessages.get(value) ?? null
        : collection(channelMessages)),
      fetchPinned: async () => collection(new Map([...channelMessages].filter(([, message]) => message.pinned))),
    },
    send: async (options) => {
      const message = makeMessage(`task-message-${nextMessage++}`, options);
      sent.push(message);
      return message;
    },
  };
  let channelFetchAttempts = 0;
  client.channels = {
    fetch: async () => {
      channelFetchAttempts += 1;
      if (channelFetchAttempts === 1) {
        const error = new Error('attempted address discord.com:443, timeout: 10000ms');
        error.name = 'ConnectTimeoutError';
        throw error;
      }
      return channel;
    },
  };

  const completionMessages = new Map();
  let completionSendDelayMs = 0;
  const completions = {
    messages: {
      fetch: async (value) => (typeof value === 'string'
        ? completionMessages.get(value) ?? null
        : collection(completionMessages)),
    },
    send: async (options) => {
      if (completionSendDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, completionSendDelayMs));
      }
      const message = {
        id: `completion-${completionMessages.size + 1}`,
        author: { id: 'bot-user', bot: true },
        content: options.content,
        allowedMentions: options.allowedMentions,
      };
      completionMessages.set(message.id, message);
      return message;
    },
  };

  const controller = new DiscordController({
    client,
    codex,
    stateStore,
    config: {
      authorizedUserIds: ['user-1', 'executor-user'],
      completionMentionUserIds: ['subscriber-user'],
      liveUpdateIntervalMs: 10,
      elapsedUpdateIntervalMs: 100,
      completionRetryBaseMs: 5,
      completionRetryMaxMs: 10,
    },
    logDir: directory,
  });
  controller.infrastructureReady = Promise.resolve({ completions });
  controller.canPinControlPanels = true;
  controller.attach();

  const notification = {
    method: 'turn/completed',
    params: {
      threadId: binding.threadId,
      turn: {
        id: 'turn-complete',
        status: 'completed',
        items: [
          { type: 'userMessage', id: 'live-user', content: [{ type: 'text', text: 'Do the work.' }] },
          { type: 'agentMessage', id: 'live-commentary', phase: 'commentary', text: 'Working.' },
          { type: 'agentMessage', id: 'final-1', phase: 'final_answer', text: 'Finished.' },
        ],
      },
    },
  };
  codex.emit('notification', notification);
  for (let attempt = 0; attempt < 100 && binding.lastPanelCompletionTurnId !== 'turn-complete'; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  assert.equal(binding.lastPanelCompletionTurnId, 'turn-complete');
  assert.ok(channelFetchAttempts >= 2);
  assert.equal(channelMessages.has('panel-old'), false);
  const panel = channelMessages.get(binding.controlPanelMessageId);
  assert.ok(panel);
  assert.equal(panel.pinned, false);
  assert.equal(panel.embeds[0].footer.text, taskPanelMarker(binding.threadId));
  assert.equal(panel.embeds[0].fields.find((field) => field.name === 'Status').value, 'idle');
  assert.deepEqual(Object.keys(binding.turnMessages['turn-complete'].userEntries), ['persisted-user']);
  assert.equal(binding.turnMessages['turn-complete'].userEntries['persisted-user'].messageIds.length, 1);
  assert.deepEqual(Object.keys(binding.turnMessages['turn-complete'].assistantEntries), ['persisted-commentary']);
  assert.deepEqual(binding.turnMessages['turn-complete'].assistantEntries['persisted-commentary'].messageIds, [liveCommentary.id]);
  assert.equal(liveCommentary.embeds[0].fields.find((field) => field.name === 'Message').value, '`persisted-commentary`');
  const finalIndex = sent.findIndex((message) => message.embeds[0]?.title === 'Codex turn completed');
  const panelIndex = sent.findIndex((message) => message.id === panel.id);
  assert.ok(finalIndex >= 0 && panelIndex > finalIndex);
  assert.equal(sent[finalIndex].embeds[0].color, 0x1971c2);
  assert.equal(sent[finalIndex].components[0].components.at(-1).custom_id, 'cx:copy:card');
  assert.equal(binding.turnMessages['turn-complete'].finalText, 'Finished.');
  const completionNotice = [...completionMessages.values()][0];
  assert.equal(
    completionNotice.content,
    `<@subscriber-user> タスクが完了しました。\n要約: Finished.\n${sent[finalIndex].url}`,
  );
  assert.deepEqual(completionNotice.allowedMentions, {
    parse: [],
    users: ['subscriber-user'],
  });
  assert.equal(panel.embeds[0].color, CONTROL_PANEL_COLOR);
  assert.notEqual(sent[finalIndex].embeds[0].color, panel.embeds[0].color);

  const sentBeforeLateItem = sent.length;
  codex.emit('notification', {
    method: 'item/completed',
    params: {
      threadId: binding.threadId,
      turnId: 'turn-complete',
      item: { type: 'agentMessage', id: 'late-commentary', phase: 'commentary', text: 'Too late.' },
    },
  });
  for (let attempt = 0; attempt < 100 && controller.notificationQueues.size; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(sent.length, sentBeforeLateItem);
  assert.equal(sent[finalIndex].embeds[0].title, 'Codex turn completed');
  assert.equal(binding.turnMessages['turn-complete'].assistantEntries['late-commentary'], undefined);
  assert.equal(binding.turnMessages['turn-complete'].status, 'completed');

  const firstPanelId = panel.id;
  const finalizedAt = binding.turnMessages['turn-complete'].finalizedAt;
  const sentCount = sent.length;
  channelMessages.delete(liveCommentary.id);
  codex.emit('notification', notification);
  for (let attempt = 0; attempt < 100 && controller.notificationQueues.size; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(binding.controlPanelMessageId, firstPanelId);
  assert.equal([...channelMessages.values()].filter((message) => message.embeds[0]?.footer?.text === taskPanelMarker(binding.threadId)).length, 1);
  assert.equal(binding.turnMessages['turn-complete'].finalizedAt, finalizedAt);
  assert.equal(sent.length, sentCount);
  assert.deepEqual(binding.turnMessages['turn-complete'].assistantEntries['persisted-commentary'].messageIds, [liveCommentary.id]);

  const restoredThread = {
    id: binding.threadId,
    name: binding.name,
    cwd: binding.cwd,
    path: null,
    status: { type: 'active' },
    turns: [notification.params.turn, {
      id: 'turn-active',
      status: 'inProgress',
      startedAt: Date.now() - 5_000,
      items: [],
    }],
  };
  binding.transcriptVersion = 11;
  codex.readThread = async () => ({ thread: restoredThread });
  codex.emit('subscriptionRestored', {
    binding: structuredClone(binding),
    thread: restoredThread,
    runtime: {},
    missedCompletion: null,
  });
  for (let attempt = 0; attempt < 100 && controller.subscriptionSyncPromises.size; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(sent.filter((message) => message.embeds[0]?.title === 'Codex message').length, 0);
  const restoredRunning = sent.findLast((message) => message.embeds[0]?.title === 'Codex running');
  const restoredElapsed = Number.parseInt(
    restoredRunning.embeds[0].fields.find((field) => field.name === 'Elapsed').value,
    10,
  );
  assert.ok(restoredElapsed >= 5);
  assert.equal(binding.turnMessages['turn-active'].startedAt, restoredThread.turns[1].startedAt);
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  assert.ok(Number.parseInt(
    restoredRunning.embeds[0].fields.find((field) => field.name === 'Elapsed').value,
    10,
  ) >= restoredElapsed + 1);
  const restoredView = controller.turnViews.get(`${binding.threadId}:turn-active`);
  if (restoredView?.elapsedTimer) clearTimeout(restoredView.elapsedTimer);
  controller.turnViews.delete(`${binding.threadId}:turn-active`);

  completionMessages.clear();
  delete binding.turnMessages['turn-complete'].completionNoticeMessageId;
  binding.lastNotifiedCompletedTurnId = null;
  binding.transcriptVersion = 11;
  completionSendDelayMs = 20;
  codex.emit('notification', notification);
  codex.emit('subscriptionRestored', {
    binding: structuredClone(binding),
    thread: {
      id: binding.threadId,
      name: binding.name,
      cwd: binding.cwd,
      path: null,
      status: { type: 'idle' },
      turns: [notification.params.turn],
    },
    runtime: {},
    missedCompletion: {
      turn: notification.params.turn,
      finalText: 'Finished.',
      needsCompletionMessage: false,
      needsCompletionNotice: true,
    },
  });
  for (let attempt = 0; attempt < 100
    && (controller.notificationQueues.size || controller.subscriptionSyncPromises.size); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(completionMessages.size, 1);
  assert.equal(
    binding.turnMessages['turn-complete'].completionNoticeMessageId,
    [...completionMessages.keys()][0],
  );

  binding.completionReportsEnabled = false;
  const suppressedNotification = {
    method: 'turn/completed',
    params: {
      threadId: binding.threadId,
      turn: {
        id: 'turn-suppressed',
        status: 'completed',
        items: [
          { type: 'userMessage', id: 'suppressed-user', content: [{ type: 'text', text: 'Keep this local.' }] },
          { type: 'agentMessage', id: 'suppressed-final', phase: 'final_answer', text: 'Not reported.' },
        ],
      },
    },
  };
  codex.emit('notification', suppressedNotification);
  for (let attempt = 0; attempt < 100 && binding.lastPanelCompletionTurnId !== 'turn-suppressed'; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(binding.lastPanelCompletionTurnId, 'turn-suppressed');
  assert.equal(binding.lastNotifiedCompletedTurnId, 'turn-suppressed');
  assert.equal(binding.turnMessages['turn-suppressed'].finalText, 'Not reported.');
  assert.equal(completionMessages.size, 1);
  const suppressedPanel = channelMessages.get(binding.controlPanelMessageId);
  assert.equal(
    suppressedPanel.embeds[0].fields.find((field) => field.name === 'Completion report').value,
    'OFF',
  );
  if (controller.taskSyncDebounceTimer) clearTimeout(controller.taskSyncDebounceTimer);
});

test('task panel completion-report selection persists the task setting', async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-completion-setting-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const client = new EventEmitter();
  client.user = { id: 'bot-user' };
  const thread = {
    id: 'thread-completion-setting',
    name: 'Completion setting',
    cwd: 'C:\\work',
    status: { type: 'idle' },
  };
  const binding = {
    threadId: thread.id,
    channelId: 'task-channel',
    name: thread.name,
    cwd: thread.cwd,
    watchLevel: 'normal',
    completionReportsEnabled: true,
    archived: false,
    taskStatus: 'idle',
    transcriptVersion: 11,
    lastPanelCompletionTurnId: 'turn-missed',
    runtimeSettings: {},
  };
  const stateStore = {
    binding: (threadId) => threadId === binding.threadId ? structuredClone(binding) : null,
    setBinding: (threadId, patch) => {
      assert.equal(threadId, binding.threadId);
      Object.assign(binding, patch);
    },
  };
  const codex = new EventEmitter();
  codex.threadMetadata = async () => ({ thread });
  const channelMessages = new Map();
  const channel = {
    id: binding.channelId,
    messages: {
      fetch: async (value) => (typeof value === 'string' ? channelMessages.get(value) ?? null : new Map(channelMessages)),
      fetchPinned: async () => new Map(),
    },
    send: async (payload) => {
      const message = {
        id: 'task-panel',
        author: { id: client.user.id, bot: true },
        content: payload.content ?? '',
        embeds: payload.embeds,
        components: payload.components,
        pinned: false,
        edit: async (next) => Object.assign(message, next),
      };
      channelMessages.set(message.id, message);
      return message;
    },
  };
  client.channels = { fetch: async () => channel };
  const controller = new DiscordController({
    client,
    codex,
    stateStore,
    config: {
      guildId: 'guild-1',
      authorizedUserIds: ['user-1'],
    },
    logDir: directory,
  });
  controller.attach();

  const interaction = {
    guildId: 'guild-1',
    channelId: channel.id,
    channel,
    user: { id: 'user-1' },
    customId: `cx:ui:task:notifications:${thread.id}`,
    values: ['completion:disabled'],
    deferred: false,
    replied: false,
    isAutocomplete: () => false,
    isChatInputCommand: () => false,
    isStringSelectMenu: () => true,
    isButton: () => false,
    isModalSubmit: () => false,
    isRepliable: () => true,
    deferUpdate: async function deferUpdate() { this.deferred = true; },
    editReply: async function editReply(payload) { this.lastReply = payload; return payload; },
    reply: async function reply(payload) { this.replied = true; this.lastReply = payload; return payload; },
    followUp: async function followUp(payload) { this.lastFollowUp = payload; return payload; },
  };
  client.emit('interactionCreate', interaction);
  for (let attempt = 0; attempt < 100 && !interaction.lastFollowUp; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  assert.equal(binding.completionReportsEnabled, false);
  assert.match(interaction.lastFollowUp.content, /OFF/);
  const panel = channelMessages.get(binding.controlPanelMessageId);
  assert.ok(panel);
  const embed = panel.embeds[0].toJSON();
  assert.equal(embed.fields.find((field) => field.name === 'Completion report').value, 'OFF');
  const notificationSelect = panel.components[2].toJSON().components[0];
  assert.match(notificationSelect.placeholder, /完了: OFF/);

  codex.emit('subscriptionRestored', {
    binding: structuredClone(binding),
    thread: {
      ...thread,
      turns: [{ id: 'turn-missed', status: 'completed', items: [] }],
    },
    runtime: {},
    missedCompletion: {
      turn: { id: 'turn-missed', status: 'completed', items: [] },
      finalText: 'Missed while disabled.',
      needsCompletionMessage: false,
      needsCompletionNotice: true,
    },
  });
  for (let attempt = 0; attempt < 100 && binding.lastNotifiedCompletedTurnId !== 'turn-missed'; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(binding.lastNotifiedCompletedTurnId, 'turn-missed');
});

test('Discord-permitted non-operator messages in bound task channels are delivered once', async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-discord-controller-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const inlineImagePath = path.join(directory, 'inline-preview.png');
  fs.writeFileSync(
    inlineImagePath,
    Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'),
  );

  const client = new EventEmitter();
  client.user = { id: 'bot-user' };
  const codex = new EventEmitter();
  let delivered = null;
  let resolveDelivery;
  const delivery = new Promise((resolve) => { resolveDelivery = resolve; });
  codex.deliver = async (threadId, prompt, attachment, clientUserMessageId) => {
    delivered = {
      threadId,
      prompt,
      attachment,
      clientUserMessageId,
    };
    resolveDelivery();
    return { mode: 'steer', turnId: 'turn-1' };
  };
  const turnRecords = new Map();
  let storedAttachments = null;
  const incomingAttachmentStore = {
    store: async (request) => {
      storedAttachments = request;
      return request.attachments.map((attachment) => ({
        id: attachment.id,
        name: attachment.name,
        path: `C:\\runtime\\${attachment.name}`,
        size: attachment.size,
        contentType: attachment.contentType,
      }));
    },
  };
  const binding = {
    threadId: 'thread-1', channelId: 'task-channel', cwd: 'C:\\work', watchLevel: 'normal', turnMessages: {},
  };
  const stateStore = {
    binding: (threadId) => (threadId === 'thread-1' ? binding : null),
    bindingByChannel: (channelId) => (channelId === 'task-channel' ? binding : null),
    turnRecord: (threadId, turnId) => turnRecords.get(`${threadId}:${turnId}`) ?? null,
    setTurnRecord: (threadId, turnId, patch) => {
      const key = `${threadId}:${turnId}`;
      const next = { ...turnRecords.get(key), ...patch };
      turnRecords.set(key, next);
      binding.turnMessages[turnId] = next;
    },
    setBinding: () => {},
  };
  const channelMessages = new Map();
  const sent = [];
  let nextMessage = 1;
  let nextAttachment = 1;
  const materializeFiles = (files = []) => new Map(files.map((file) => {
    const id = `bot-attachment-${nextAttachment++}`;
    const size = Buffer.isBuffer(file.attachment) ? file.attachment.length : file.size;
    return [id, { id, name: file.name, size }];
  }));
  const channel = {
    messages: {
      fetch: async (value) => (typeof value === 'string'
        ? channelMessages.get(value) ?? null
        : Object.assign(new Map(channelMessages), {
          last: () => [...channelMessages.values()].at(-1) ?? null,
          find: (predicate) => [...channelMessages.values()].find(predicate),
        })),
    },
    send: async (options) => {
      const message = {
        id: `bot-message-${nextMessage++}`,
        author: { id: 'bot-user', bot: true },
        content: options.content ?? '',
        embeds: (options.embeds ?? []).map((embed) => embed.toJSON()),
        components: (options.components ?? []).map((component) => component.toJSON?.() ?? component),
        attachments: materializeFiles(options.files),
        edit: async (next) => {
          message.content = next.content ?? message.content;
          if (next.embeds) message.embeds = next.embeds.map((embed) => embed.toJSON?.() ?? embed);
          if (next.components) message.components = next.components.map((component) => component.toJSON?.() ?? component);
          if (next.attachments) {
            message.attachments = new Map(next.attachments
              .map((attachment) => [attachment.id, message.attachments.get(attachment.id)])
              .filter(([, attachment]) => attachment));
          }
          for (const [id, attachment] of materializeFiles(next.files)) {
            message.attachments.set(id, attachment);
          }
          return message;
        },
        delete: async () => { channelMessages.delete(message.id); },
      };
      channelMessages.set(message.id, message);
      sent.push(message);
      return message;
    },
  };
  client.channels = { fetch: async () => channel };
  const controller = new DiscordController({
    client,
    codex,
    stateStore,
    config: {
      plainMessageInputEnabled: true,
      guildId: 'guild-1',
      authorizedUserIds: ['user-1'],
      fileShareEnabled: true,
      fileShareChunkBytes: 100_000,
      liveUpdateIntervalMs: 100,
    },
    logDir: directory,
    incomingAttachmentStore,
  });
  controller.attach();

  const reactions = [];
  const replies = [];
  let markPendingReactionStarted;
  let releasePendingReaction;
  const pendingReactionStarted = new Promise((resolve) => { markPendingReactionStarted = resolve; });
  const pendingReactionRelease = new Promise((resolve) => { releasePendingReaction = resolve; });
  let originalDeleted = false;
  const originalMessage = {
    id: 'message-1',
    guildId: 'guild-1',
    channelId: 'task-channel',
    webhookId: null,
    author: { id: 'task-member', tag: 'member#0001', bot: false },
    memberPermissions: {
      has: (permission) => [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages].includes(permission),
    },
    content: 'run the requested task',
    attachments: new Map([
      ['attachment-image', {
        id: 'attachment-image',
        name: 'screen.png',
        size: 123,
        contentType: 'image/png',
        url: 'https://discord.test/screen.png',
      }],
      ['attachment-pdf', {
        id: 'attachment-pdf',
        name: 'requirements.pdf',
        size: 456,
        contentType: 'application/pdf',
        url: 'https://discord.test/requirements.pdf',
      }],
    ]),
    reactions: { resolve: () => null },
    react: async (reaction) => {
      reactions.push(reaction);
      if (reaction === '⏳') {
        markPendingReactionStarted();
        await pendingReactionRelease;
      }
    },
    reply: async (options) => { replies.push(options); },
    delete: async () => { originalDeleted = true; channelMessages.delete('message-1'); },
  };
  channelMessages.set(originalMessage.id, originalMessage);
  client.emit('messageCreate', originalMessage);

  await pendingReactionStarted;
  const deliveredBeforeReaction = await Promise.race([
    delivery.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 100)),
  ]);
  releasePendingReaction();
  assert.equal(deliveredBeforeReaction, true);
  await delivery;
  for (let attempt = 0; attempt < 50 && !reactions.includes('✅'); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(delivered.threadId, 'thread-1');
  assert.equal(delivered.prompt, 'run the requested task');
  assert.deepEqual(delivered.attachment, [
    {
      id: 'attachment-image',
      name: 'screen.png',
      path: 'C:\\runtime\\screen.png',
      size: 123,
      contentType: 'image/png',
      kind: 'localImage',
    },
    {
      id: 'attachment-pdf',
      name: 'requirements.pdf',
      path: 'C:\\runtime\\requirements.pdf',
      size: 456,
      contentType: 'application/pdf',
      kind: 'file',
    },
  ]);
  assert.equal(storedAttachments.threadId, 'thread-1');
  assert.equal(storedAttachments.sourceId, 'message-1');
  assert.deepEqual(
    storedAttachments.attachments.map((attachment) => attachment.name),
    ['screen.png', 'requirements.pdf'],
  );
  assert.match(delivered.clientUserMessageId, /^discord-[a-f0-9]{12}$/);
  assert.deepEqual(reactions, ['⏳', '✅'], JSON.stringify(replies));
  assert.deepEqual(replies, []);
  assert.equal(originalDeleted, true);
  const userCard = sent.find((message) => message.embeds[0]?.title === 'User message');
  assert.ok(userCard);
  const runningAfterInput = sent.at(-1);
  assert.equal(runningAfterInput.embeds[0]?.title, 'Codex running');
  assert.ok(sent.indexOf(runningAfterInput) > sent.indexOf(userCard));
  const trailingCard = await channel.send({ embeds: [new EmbedBuilder().setTitle('Trailing test card')] });
  binding.transcriptVersion = 11;
  binding.runtimeSettings = {};
  codex.readThread = async () => ({
    thread: {
      id: binding.threadId,
      name: 'Task',
      cwd: binding.cwd,
      path: null,
      status: { type: 'active' },
      turns: [{
        id: 'turn-1',
        status: 'inProgress',
        items: [{
          type: 'mcpToolCall',
          id: 'tool-image-restored',
          status: 'completed',
          result: {
            content: [{
              type: 'image',
              mimeType: 'image/png',
              data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
            }],
          },
        }],
      }],
    },
  });
  codex.emit('subscriptionRestored', {
    binding: structuredClone(binding),
    thread: (await codex.readThread()).thread,
    runtime: {},
    missedCompletion: null,
  });
  for (let attempt = 0; attempt < 100 && controller.subscriptionSyncPromises.size; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const runningAfterRestore = sent.at(-1);
  assert.equal(runningAfterRestore.embeds[0]?.title, 'Codex running');
  assert.ok(sent.indexOf(runningAfterRestore) > sent.indexOf(trailingCard));
  assert.notEqual(runningAfterRestore.id, runningAfterInput.id);
  const restoredImageCard = [...channelMessages.values()].find((message) => message.embeds?.[0]?.fields
    ?.some((field) => field.name === 'Item' && field.value === '`tool-image-restored`'));
  assert.equal(restoredImageCard?.embeds[0]?.title, 'Codex image');
  assert.deepEqual(
    [...restoredImageCard.attachments.values()].map((attachment) => attachment.name),
    ['codex-image-tool-image-restored-1.png'],
  );
  assert.ok(sent.indexOf(runningAfterRestore) > sent.indexOf(restoredImageCard));
  assert.equal(userCard.embeds[0].color, 0xe67e22);
  assert.equal(userCard.embeds[0].description, 'run the requested task');
  assert.equal(userCard.components[0].components[0].custom_id, 'cx:copy:card');
  assert.deepEqual(userCard.embeds[0].fields.map((field) => field.name), ['Task', 'Turn', 'Message']);
  assert.equal(
    userCard.embeds[0].fields.find((field) => field.name === 'Message').value,
    `\`${delivered.clientUserMessageId}\``,
  );
  assert.deepEqual(turnRecords.get('thread-1:turn-1').userMessageIds, [userCard.id]);
  assert.deepEqual(turnRecords.get('thread-1:turn-1').executorUserIds, ['task-member']);
  assert.deepEqual(
    turnRecords.get('thread-1:turn-1').userEntries[delivered.clientUserMessageId].messageIds,
    [userCard.id],
  );

  const unauthorizedReplies = [];
  const unauthorizedMessage = {
    ...originalMessage,
    id: 'message-unauthorized',
    author: { id: 'user-2', tag: 'other#0002', bot: false },
    memberPermissions: { has: () => false },
    content: 'do not deliver this prompt',
    reply: async (options) => { unauthorizedReplies.push(options); },
    delete: async () => { throw new Error('Unauthorized prompt must not be deleted.'); },
  };
  channelMessages.set(unauthorizedMessage.id, unauthorizedMessage);
  client.emit('messageCreate', unauthorizedMessage);
  for (let attempt = 0; attempt < 50 && unauthorizedReplies.length === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(delivered.prompt, 'run the requested task');
  assert.match(unauthorizedReplies[0].content, /拒否しました/);
  assert.deepEqual(unauthorizedReplies[0].allowedMentions, { parse: [] });

  const unauthorizedCommand = {
    guildId: 'guild-1',
    channelId: 'task-channel',
    user: { id: 'user-2' },
    commandName: 'codex',
    isAutocomplete: () => false,
    isChatInputCommand: () => true,
    isStringSelectMenu: () => false,
    isButton: () => false,
    isModalSubmit: () => false,
    isRepliable: () => true,
    reply: async function reply(options) { this.lastReply = options; },
  };
  client.emit('interactionCreate', unauthorizedCommand);
  for (let attempt = 0; attempt < 50 && !unauthorizedCommand.lastReply; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.match(unauthorizedCommand.lastReply.content, /拒否しました/);
  assert.equal(unauthorizedCommand.lastReply.ephemeral, true);

  const permittedTaskCommand = {
    ...unauthorizedCommand,
    user: { id: 'task-member' },
    memberPermissions: {
      has: (permission) => [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages].includes(permission),
    },
    options: {
      getSubcommand: () => 'help',
      getSubcommandGroup: () => null,
    },
    lastReply: null,
  };
  client.emit('interactionCreate', permittedTaskCommand);
  for (let attempt = 0; attempt < 50 && !permittedTaskCommand.lastReply; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(permittedTaskCommand.lastReply.ephemeral, true);
  assert.match(permittedTaskCommand.lastReply.content, /codex deliver/);

  const deniedControlCommand = {
    ...permittedTaskCommand,
    options: {
      getSubcommand: () => 'sync',
      getSubcommandGroup: () => null,
    },
    lastReply: null,
  };
  client.emit('interactionCreate', deniedControlCommand);
  for (let attempt = 0; attempt < 50 && !deniedControlCommand.lastReply; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.match(deniedControlCommand.lastReply.content, /制御者権限/);

  const deniedOtherTaskCommand = {
    ...permittedTaskCommand,
    options: {
      getSubcommand: () => 'status',
      getSubcommandGroup: () => null,
      getString: (name) => (name === 'task' ? 'other-thread' : null),
    },
    deferred: false,
    lastReply: null,
    deferReply: async function deferReply() { this.deferred = true; },
    editReply: async function editReply(options) { this.lastReply = options; },
  };
  client.emit('interactionCreate', deniedOtherTaskCommand);
  for (let attempt = 0; attempt < 50 && !deniedOtherTaskCommand.lastReply; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.match(deniedOtherTaskCommand.lastReply.content, /現在のタスク以外/);

  const assistantText = `first update [artifact](C:\\work\\artifact.txt) ![preview](<${inlineImagePath}>)`;
  codex.emit('notification', {
    method: 'item/started',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: {
        type: 'userMessage',
        id: 'user-item-1',
        clientId: delivered.clientUserMessageId,
        content: [{ type: 'text', text: delivered.prompt }],
      },
    },
  });
  for (let attempt = 0; attempt < 100
    && (controller.notificationQueues.size
      || !turnRecords.get('thread-1:turn-1')?.userEntries?.['user-item-1']); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const stableUserCards = [...channelMessages.values()]
    .filter((message) => message.embeds?.[0]?.title === 'User message');
  assert.equal(stableUserCards.length, 1);
  const stableUserCard = stableUserCards[0];
  assert.deepEqual(
    turnRecords.get('thread-1:turn-1').userEntries['user-item-1'].messageIds,
    [stableUserCard.id],
  );
  assert.equal(turnRecords.get('thread-1:turn-1').userEntries[delivered.clientUserMessageId], undefined);
  assert.equal(
    stableUserCard.embeds[0].fields.find((field) => field.name === 'Message').value,
    '`user-item-1`',
  );
  for (let attempt = 0; attempt < 100
    && !turnRecords.get('thread-1:turn-1')?.liveMessageId; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  codex.emit('notification', {
    method: 'item/started',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: { type: 'agentMessage', id: 'assistant-item-1', phase: 'commentary', text: '' },
    },
  });
  for (let attempt = 0; attempt < 100
    && !turnRecords.get('thread-1:turn-1')?.assistantEntries?.['assistant-item-1']; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  codex.emit('notification', {
    method: 'item/agentMessage/delta',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'assistant-item-1',
      delta: assistantText,
    },
  });
  codex.emit('notification', {
    method: 'item/completed',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: { type: 'agentMessage', id: 'assistant-item-1', phase: 'commentary', text: assistantText },
    },
  });
  for (let attempt = 0; attempt < 100
    && turnRecords.get('thread-1:turn-1')?.assistantEntries?.['assistant-item-1']?.text !== assistantText; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  codex.emit('notification', {
    method: 'item/started',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: { type: 'agentMessage', id: 'assistant-item-2', phase: 'commentary', text: '' },
    },
  });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const titles = [...channelMessages.values()].map((message) => message.embeds?.[0]?.title);
    if (titles.includes('Codex message') && titles.includes('Codex running')) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await new Promise((resolve) => setTimeout(resolve, 150));
  const pastAssistant = [...channelMessages.values()]
    .find((message) => message.embeds?.[0]?.title === 'Codex message');
  const liveAssistant = [...channelMessages.values()]
    .find((message) => message.embeds?.[0]?.title === 'Codex running');
  const diagnostic = JSON.stringify([...channelMessages.values()].map((message) => ({
    id: message.id,
    title: message.embeds?.[0]?.title,
    fields: message.embeds?.[0]?.fields,
  })));
  assert.ok(pastAssistant, diagnostic);
  assert.ok(liveAssistant, diagnostic);
  for (const [itemId, parts] of [
    ['reasoning-1', ['**Planning first fix**', 'Verifying first fix']],
    ['reasoning-2', ['**Planning latest fix**', 'Verifying latest fix']],
  ]) {
    codex.emit('notification', {
      method: 'item/started',
      params: { threadId: 'thread-1', turnId: 'turn-1', item: { type: 'reasoning', id: itemId, summary: [] } },
    });
    for (const [summaryIndex, delta] of parts.entries()) {
      codex.emit('notification', {
        method: 'item/reasoning/summaryPartAdded',
        params: { threadId: 'thread-1', turnId: 'turn-1', itemId, summaryIndex },
      });
      codex.emit('notification', {
        method: 'item/reasoning/summaryTextDelta',
        params: { threadId: 'thread-1', turnId: 'turn-1', itemId, summaryIndex, delta },
      });
    }
    codex.emit('notification', {
      method: 'item/completed',
      params: { threadId: 'thread-1', turnId: 'turn-1', item: { type: 'reasoning', id: itemId, summary: parts } },
    });
  }
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const reasoning = liveAssistant.embeds[0].fields.find((field) => field.name === 'Reasoning')?.value;
    if (reasoning?.includes('Planning latest fix')) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(
    liveAssistant.embeds[0].fields.find((field) => field.name === 'Reasoning')?.value,
    '- Planning latest fix\n- Verifying latest fix',
  );
  assert.doesNotMatch(
    liveAssistant.embeds[0].fields.find((field) => field.name === 'Reasoning')?.value ?? '',
    /first fix/,
  );
  assert.equal(pastAssistant.embeds[0].description, assistantText);
  assert.equal(pastAssistant.components[0].components[0].custom_id, 'cx:files:linked');
  assert.equal(pastAssistant.components[0].components[1].custom_id, 'cx:copy:card');
  assert.equal(liveAssistant.components[0].components.at(-1).custom_id, 'cx:copy:card');
  assert.equal(liveAssistant.embeds[0].fields.some((field) => field.name === 'Recent work'), false);
  assert.deepEqual(pastAssistant.embeds[0].fields.map((field) => field.name), ['Task', 'Turn', 'Message']);
  assert.equal(liveAssistant.embeds[0].fields.find((field) => field.name === 'Message').value, '`assistant-item-2`');
  assert.deepEqual(turnRecords.get('thread-1:turn-1').assistantEntries['assistant-item-1'].messageIds, [pastAssistant.id]);
  assert.equal(turnRecords.get('thread-1:turn-1').assistantEntries['assistant-item-1'].localFiles[0].target, 'C:\\work\\artifact.txt');
  assert.equal(
    turnRecords.get('thread-1:turn-1').assistantEntries['assistant-item-1'].localFiles[1].target,
    inlineImagePath,
  );
  assert.deepEqual(
    [...pastAssistant.attachments.values()].map((attachment) => attachment.name),
    ['inline-preview.png'],
  );
  assert.deepEqual(turnRecords.get('thread-1:turn-1').assistantEntries['assistant-item-2'].messageIds, [liveAssistant.id]);
  assert.equal(new Set(turnRecords.get('thread-1:turn-1').assistantMessageIds).size, 2);

  const codexImageNotification = {
    method: 'item/completed',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: {
        type: 'mcpToolCall',
        id: 'tool-image-1',
        status: 'completed',
        result: {
          content: [{
            type: 'image',
            mimeType: 'image/png',
            data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
          }],
        },
      },
    },
  };
  codex.emit('notification', codexImageNotification);
  for (let attempt = 0; attempt < 100
    && (controller.notificationQueues.size
      || !turnRecords.get('thread-1:turn-1')?.imageEntries?.['tool-image-1']); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  let codexImageCards = [...channelMessages.values()]
    .filter((message) => message.embeds?.[0]?.fields
      ?.some((field) => field.name === 'Item' && field.value === '`tool-image-1`'));
  assert.equal(codexImageCards.length, 1);
  assert.deepEqual(
    [...codexImageCards[0].attachments.values()].map((attachment) => attachment.name),
    ['codex-image-tool-image-1-1.png'],
  );
  assert.equal(
    codexImageCards[0].embeds[0].fields.find((field) => field.name === 'Item').value,
    '`tool-image-1`',
  );
  assert.ok(turnRecords.get('thread-1:turn-1').imageMessageIds.includes(codexImageCards[0].id));
  assert.equal(turnRecords.get('thread-1:turn-1').imageEntries['tool-image-1'].attachments[0].sha256.length, 64);
  assert.equal([...channelMessages.values()].at(-1).embeds[0].title, 'Codex running');

  codex.emit('notification', codexImageNotification);
  for (let attempt = 0; attempt < 100 && controller.notificationQueues.size; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  codexImageCards = [...channelMessages.values()]
    .filter((message) => message.embeds?.[0]?.fields
      ?.some((field) => field.name === 'Item' && field.value === '`tool-image-1`'));
  assert.equal(codexImageCards.length, 1);

  const previousClientUserMessageId = delivered.clientUserMessageId;
  const attachmentOnlyReactions = [];
  const attachmentOnlyMessage = {
    ...originalMessage,
    id: 'message-attachment-only',
    content: '',
    attachments: new Map([['attachment-image', originalMessage.attachments.get('attachment-image')]]),
    react: async (reaction) => { attachmentOnlyReactions.push(reaction); },
    delete: async () => { channelMessages.delete('message-attachment-only'); },
  };
  channelMessages.set(attachmentOnlyMessage.id, attachmentOnlyMessage);
  client.emit('messageCreate', attachmentOnlyMessage);
  for (let attempt = 0; attempt < 100
    && delivered.clientUserMessageId === previousClientUserMessageId; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(delivered.prompt, ATTACHMENT_ONLY_PROMPT);
  assert.match(delivered.prompt, /単なる確認だけで終わらず/);
  assert.deepEqual(attachmentOnlyReactions, ['⏳', '✅']);
});

test('transfer-text accepts authorized users and webhooks while rejecting other senders', async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-transfer-controller-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const client = new EventEmitter();
  client.user = { id: 'bot-user' };
  client.channels = { fetch: async () => null };
  const codex = new EventEmitter();
  codex.deliver = async () => { throw new Error('transfer-text must not deliver to Codex'); };
  const stored = [];
  const transferEvents = [];
  const textTransferStore = {
    ensureDirectory: async () => directory,
    store: async (text, timestamp) => {
      if (text === 'failed payload') {
        transferEvents.push('store-failed:failed payload');
        throw new Error('simulated local write failure');
      }
      const record = {
        path: path.join(directory, `${timestamp}.txt`),
        filename: `${timestamp}.txt`,
        timestamp,
        bytes: Buffer.byteLength(text),
      };
      stored.push({ text, timestamp, record });
      transferEvents.push(`stored:${text}`);
      return record;
    },
  };
  const controller = new DiscordController({
    client,
    codex,
    stateStore: {
      bindingByChannel: () => { throw new Error('transfer-text must bypass task binding'); },
    },
    config: {
      guildId: 'guild-1',
      authorizedUserIds: ['user-1'],
      textTransferEnabled: true,
      plainMessageInputEnabled: false,
    },
    logDir: directory,
    textTransferStore,
  });
  controller.transferTextChannelId = 'transfer-channel';
  controller.attach();

  const makeMessage = ({
    id,
    content,
    author,
    webhookId = null,
    createdTimestamp,
  }) => {
    const reactions = [];
    const replies = [];
    return {
      message: {
        id,
        guildId: 'guild-1',
        channelId: 'transfer-channel',
        content,
        author,
        webhookId,
        createdTimestamp,
        react: async (emoji) => { reactions.push(emoji); },
        reply: async (options) => { replies.push(options); },
        delete: async () => { transferEvents.push(`deleted:${id}`); },
      },
      reactions,
      replies,
    };
  };

  const webhook = makeMessage({
    id: 'webhook-message',
    content: 'webhook payload',
    author: { id: 'webhook-user', bot: true },
    webhookId: 'webhook-1',
    createdTimestamp: 1000,
  });
  const authorized = makeMessage({
    id: 'authorized-message',
    content: 'authorized payload',
    author: { id: 'user-1', bot: false },
    createdTimestamp: 1001,
  });
  const unauthorized = makeMessage({
    id: 'unauthorized-message',
    content: 'unauthorized payload',
    author: { id: 'user-2', bot: false },
    createdTimestamp: 1002,
  });
  const otherBot = makeMessage({
    id: 'bot-message',
    content: 'bot payload',
    author: { id: 'other-bot', bot: true },
    createdTimestamp: 1003,
  });
  const failed = makeMessage({
    id: 'failed-message',
    content: 'failed payload',
    author: { id: 'user-1', bot: false },
    createdTimestamp: 1004,
  });

  client.emit('messageCreate', webhook.message);
  client.emit('messageCreate', authorized.message);
  client.emit('messageCreate', unauthorized.message);
  client.emit('messageCreate', otherBot.message);
  client.emit('messageCreate', failed.message);
  for (let attempt = 0; attempt < 100
    && (stored.length < 2 || unauthorized.replies.length < 1 || failed.reactions.length < 1); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  assert.deepEqual(stored.map(({ text, timestamp }) => ({ text, timestamp })), [
    { text: 'webhook payload', timestamp: 1000 },
    { text: 'authorized payload', timestamp: 1001 },
  ]);
  assert.deepEqual(transferEvents, [
    'stored:webhook payload',
    'deleted:webhook-message',
    'stored:authorized payload',
    'deleted:authorized-message',
    'store-failed:failed payload',
  ]);
  assert.deepEqual(webhook.reactions, []);
  assert.deepEqual(authorized.reactions, []);
  assert.equal(unauthorized.replies.length, 1);
  assert.match(unauthorized.replies[0].content, /拒否しました/);
  assert.deepEqual(unauthorized.replies[0].allowedMentions, { parse: [] });
  assert.deepEqual(otherBot.reactions, []);
  assert.deepEqual(otherBot.replies, []);
  assert.deepEqual(failed.reactions, ['❌']);
});

test('ordinary messages in an unbound managed-project channel create and reuse one Codex task', async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-discord-controller-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const client = new EventEmitter();
  client.user = { id: 'bot-user' };
  const codex = new EventEmitter();
  const started = [];
  const named = [];
  const delivered = [];
  codex.startThread = async (cwd) => {
    started.push(cwd);
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { thread: { id: 'thread-new', cwd, status: { type: 'idle' }, turns: [] } };
  };
  codex.setThreadName = async (threadId, name) => { named.push({ threadId, name }); };
  codex.deliver = async (threadId, prompt, attachment) => {
    const turnId = `turn-${delivered.length + 1}`;
    const itemId = `user-item-${delivered.length + 1}`;
    delivered.push({ threadId, prompt, attachment, turnId });
    setImmediate(() => codex.emit('notification', {
      method: 'item/started',
      params: {
        threadId,
        turnId,
        item: { type: 'userMessage', id: itemId, content: [{ type: 'text', text: prompt }] },
      },
    }));
    return { mode: delivered.length === 1 ? 'send' : 'steer', turnId };
  };

  const bindings = new Map();
  const turnRecords = new Map();
  const stateStore = {
    binding: (threadId) => bindings.has(threadId) ? { threadId, ...bindings.get(threadId) } : null,
    bindingByChannel: (channelId) => {
      const entry = [...bindings.entries()].find(([, binding]) => binding.channelId === channelId);
      return entry ? { threadId: entry[0], ...entry[1] } : null;
    },
    projectCategories: () => [{
      projectKey: 'project-key',
      projectId: 'project-id',
      path: 'C:\\work',
      categoryIds: ['project-category'],
    }],
    setBinding: (threadId, patch) => bindings.set(threadId, { ...bindings.get(threadId), ...patch }),
    removeBinding: (threadId) => bindings.delete(threadId),
    turnRecord: (threadId, turnId) => turnRecords.get(`${threadId}:${turnId}`) ?? null,
    setTurnRecord: (threadId, turnId, patch) => {
      const key = `${threadId}:${turnId}`;
      turnRecords.set(key, { ...turnRecords.get(key), ...patch });
    },
  };

  const channelMessages = new Map();
  const sent = [];
  let nextBotMessage = 1;
  const channel = {
    id: 'new-channel',
    name: 'draft-feature',
    guildId: 'guild-1',
    type: ChannelType.GuildText,
    parentId: 'project-category',
    topic: null,
    permissionsLocked: false,
    setName: async (name) => {
      const oldChannel = { ...channel };
      channel.name = name;
      client.emit('channelUpdate', oldChannel, { ...channel });
      return channel;
    },
    setTopic: async (topic) => { channel.topic = topic; return channel; },
    lockPermissions: async () => { channel.permissionsLocked = true; return channel; },
    messages: {
      fetch: async (value) => (typeof value === 'string'
        ? channelMessages.get(value) ?? null
        : Object.assign(new Map(channelMessages), {
          last: () => [...channelMessages.values()].at(-1) ?? null,
        })),
    },
    send: async (options) => {
      const message = {
        id: `bot-message-${nextBotMessage++}`,
        author: { id: 'bot-user', bot: true },
        content: options.content ?? '',
        embeds: (options.embeds ?? []).map((embed) => embed.toJSON()),
        attachments: new Map(),
        edit: async (next) => {
          message.content = next.content ?? message.content;
          if (next.embeds) message.embeds = next.embeds.map((embed) => embed.toJSON?.() ?? embed);
          if (next.attachments?.length === 0) message.attachments.clear();
          return message;
        },
        delete: async () => { channelMessages.delete(message.id); },
      };
      channelMessages.set(message.id, message);
      sent.push(message);
      return message;
    },
  };
  client.channels = { fetch: async () => channel };

  const controller = new DiscordController({
    client,
    codex,
    stateStore,
    config: {
      plainMessageInputEnabled: true,
      guildId: 'guild-1',
      allowedUserIds: ['user-1'],
      defaultWatchLevel: 'normal',
      liveUpdateIntervalMs: 100,
    },
    logDir: directory,
  });
  controller.attach();

  let releaseTaskListing;
  controller.taskSyncPromise = new Promise(() => {});
  controller.taskListBarrier = {
    promise: new Promise((resolve) => { releaseTaskListing = resolve; }),
  };

  const makeMessage = (id, content) => {
    const reactions = [];
    const message = {
      id,
      guildId: 'guild-1',
      channelId: channel.id,
      channel,
      webhookId: null,
      author: { id: 'user-1', tag: 'user#0001', bot: false },
      content,
      attachments: new Map(),
      reactions: { resolve: () => null },
      react: async (reaction) => { reactions.push(reaction); },
      reply: async () => {},
      delete: async () => { channelMessages.delete(id); },
    };
    channelMessages.set(id, message);
    return { message, reactions };
  };
  const first = makeMessage('user-message-1', 'implement the first part');
  const second = makeMessage('user-message-2', 'then verify it');
  client.emit('messageCreate', first.message);
  client.emit('messageCreate', second.message);

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(started.length, 0);
  releaseTaskListing();
  controller.taskListBarrier = null;

  for (let attempt = 0; attempt < 300 && !second.reactions.includes('✅'); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.deepEqual(started, ['C:\\work']);
  assert.deepEqual(named, [{ threadId: 'thread-new', name: 'draft feature' }]);
  assert.deepEqual(delivered.map(({ threadId, prompt }) => ({ threadId, prompt })), [
    { threadId: 'thread-new', prompt: 'implement the first part' },
    { threadId: 'thread-new', prompt: 'then verify it' },
  ]);
  assert.deepEqual(first.reactions, ['⏳', '✅']);
  assert.deepEqual(second.reactions, ['⏳', '✅']);
  assert.equal(bindings.get('thread-new').channelId, channel.id);
  assert.equal(bindings.get('thread-new').projectKey, 'project-key');
  assert.equal(channel.name, '⚫-draft-feature');
  assert.match(channel.topic, /Codex task: thread-new/);
  assert.equal(channel.permissionsLocked, true);
  assert.equal(channelMessages.has('user-message-1'), false);
  assert.equal(channelMessages.has('user-message-2'), false);
  assert.equal(sent.filter((message) => message.embeds[0]?.title === 'User message').length, 2);
  controller.taskSyncPromise = null;
});

test('renaming a bound task channel renames the Codex task', async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-discord-controller-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const client = new EventEmitter();
  client.user = { id: 'bot-user' };
  const codex = new EventEmitter();
  const renamed = [];
  codex.setThreadName = async (threadId, name) => { renamed.push({ threadId, name }); };
  const binding = {
    threadId: 'thread-1',
    channelId: 'task-channel',
    categoryId: 'project-category',
    projectKey: 'project-key',
    name: 'old task',
    archived: false,
  };
  const stateStore = {
    bindingByChannel: (channelId) => channelId === binding.channelId ? { ...binding } : null,
    setBinding: (threadId, patch) => {
      assert.equal(threadId, binding.threadId);
      Object.assign(binding, patch);
    },
  };
  const controller = new DiscordController({
    client,
    codex,
    stateStore,
    config: { guildId: 'guild-1' },
    logDir: directory,
  });
  controller.attach();

  client.emit('channelUpdate', {
    id: binding.channelId,
    guildId: 'guild-1',
    type: ChannelType.GuildText,
    parentId: 'project-category',
    name: '⚫-old-task',
  }, {
    id: binding.channelId,
    guildId: 'guild-1',
    type: ChannelType.GuildText,
    parentId: 'project-category',
    name: 'renamed-task',
  });
  for (let attempt = 0; attempt < 100 && binding.name !== 'renamed task'; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.deepEqual(renamed, [{ threadId: 'thread-1', name: 'renamed task' }]);
  assert.equal(binding.name, 'renamed task');
});

test('task control panel delivery-mode select opens the compose modal', async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-discord-controller-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const client = new EventEmitter();
  client.user = { id: 'bot-user' };
  const codex = new EventEmitter();
  const binding = { threadId: 'thread-1', channelId: 'task-channel', archived: false };
  const stateStore = {
    binding: (threadId) => threadId === binding.threadId ? { ...binding } : null,
  };
  const controller = new DiscordController({
    client,
    codex,
    stateStore,
    config: { guildId: 'guild-1', allowedUserIds: ['user-1'] },
    logDir: directory,
  });
  controller.attach();

  let shownModal = null;
  client.emit('interactionCreate', {
    guildId: 'guild-1',
    channelId: binding.channelId,
    user: { id: 'user-1' },
    customId: `cx:ui:task:compose:${binding.threadId}`,
    values: ['deliver'],
    isAutocomplete: () => false,
    isChatInputCommand: () => false,
    isStringSelectMenu: () => true,
    isButton: () => false,
    isModalSubmit: () => false,
    isRepliable: () => true,
    showModal: async (modal) => { shownModal = modal.toJSON(); },
  });
  for (let attempt = 0; attempt < 100 && !shownModal; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.match(shownModal.custom_id, /^cx:compose:/);
  assert.equal(shownModal.title, 'Codex deliver');
  assert.equal(shownModal.components[0].components[0].custom_id, 'prompt');
});

test('task management menu opens catalog-backed UI and confirms permission changes', async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-discord-controller-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const client = new EventEmitter();
  client.user = { id: 'bot-user' };
  const codex = new EventEmitter();
  const binding = {
    threadId: 'thread-1', channelId: 'task-channel', archived: false, cwd: 'C:\\work', runtimeSettings: {},
  };
  const stateStore = {
    binding: (threadId) => threadId === binding.threadId ? structuredClone(binding) : null,
    setBinding: (threadId, patch) => {
      assert.equal(threadId, binding.threadId);
      Object.assign(binding, patch);
    },
  };
  const settingsUpdates = [];
  codex.resumeThread = async () => ({
    thread: { id: binding.threadId, name: 'Task one', cwd: binding.cwd, status: { type: 'idle' } },
    cwd: binding.cwd,
    model: 'gpt-test',
    reasoningEffort: 'high',
    activePermissionProfile: { id: ':workspace' },
  });
  codex.listModels = async () => [{
    id: 'gpt-test', model: 'gpt-test', displayName: 'GPT Test', description: 'Test', hidden: false,
    defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'high', description: 'Deep' }],
    serviceTiers: [], supportsPersonality: true,
  }];
  codex.listPermissionProfiles = async () => [
    { id: ':workspace', allowed: true },
    { id: ':danger-full-access', allowed: true },
  ];
  codex.listCollaborationModes = async () => [{ name: 'Default', mode: 'default', model: null, reasoning_effort: null }];
  codex.getGoal = async () => ({ goal: null });
  codex.listBackgroundTerminals = async () => [];
  codex.updateThreadSettings = async (threadId, patch) => { settingsUpdates.push({ threadId, patch }); };
  const controller = new DiscordController({
    client,
    codex,
    stateStore,
    config: { guildId: 'guild-1', allowedUserIds: ['user-1'] },
    logDir: directory,
  });
  controller.attach();

  const emitInteraction = async (interaction) => {
    client.emit('interactionCreate', interaction);
    for (let attempt = 0; attempt < 100 && !interaction.lastReply; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(interaction.lastReply);
    return interaction.lastReply;
  };
  const base = {
    guildId: 'guild-1',
    channelId: binding.channelId,
    user: { id: 'user-1' },
    isAutocomplete: () => false,
    isChatInputCommand: () => false,
    isModalSubmit: () => false,
    isRepliable: () => true,
    deferred: false,
    replied: false,
    deferReply: async function deferReply() { this.deferred = true; },
    deferUpdate: async function deferUpdate() { this.deferred = true; },
    editReply: async function editReply(payload) { this.lastReply = payload; return payload; },
    reply: async function reply(payload) { this.replied = true; this.lastReply = payload; return payload; },
  };

  const controls = await emitInteraction({
    ...base,
    customId: `cx:ui:task:actions:${binding.threadId}`,
    values: ['controls'],
    isButton: () => false,
    isStringSelectMenu: () => true,
  });
  assert.deepEqual(controls.components.map((row) => row.toJSON().components[0].custom_id), [
    'cx:ctl:model:thread-1',
    'cx:ctl:effort:thread-1',
    'cx:ctl:permission:thread-1',
    'cx:ctl:mode:thread-1',
    'cx:ctl:more:thread-1',
  ]);

  const permissionInteraction = {
    ...base,
    customId: `cx:ctl:permission:${binding.threadId}`,
    values: [':danger-full-access'],
    isButton: () => false,
    isStringSelectMenu: () => true,
  };
  const confirmation = await emitInteraction(permissionInteraction);
  assert.equal(settingsUpdates.length, 0);
  const confirmId = confirmation.components[0].toJSON().components[0].custom_id;
  assert.match(confirmId, /^cx:confirm:[^:]+:yes$/);

  await emitInteraction({
    ...base,
    customId: confirmId,
    isButton: () => true,
    isStringSelectMenu: () => false,
  });
  assert.deepEqual(settingsUpdates, [{
    threadId: binding.threadId,
    patch: { permissions: ':danger-full-access' },
  }]);
});

test('ordinary messages in unmanaged channels do not create Codex tasks', async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-discord-controller-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const client = new EventEmitter();
  client.user = { id: 'bot-user' };
  const codex = new EventEmitter();
  let starts = 0;
  codex.startThread = async () => { starts += 1; };
  const stateStore = {
    bindingByChannel: () => null,
    projectCategories: () => [{
      projectKey: 'project-key',
      projectId: 'project-id',
      path: 'C:\\work',
      categoryIds: ['project-category'],
    }],
  };
  const channel = {
    id: 'unmanaged-channel',
    type: ChannelType.GuildText,
    parentId: 'other-category',
  };
  const controller = new DiscordController({
    client,
    codex,
    stateStore,
    config: {
      plainMessageInputEnabled: true,
      guildId: 'guild-1',
      allowedUserIds: ['user-1'],
    },
    logDir: directory,
  });
  controller.attach();
  const reactions = [];
  client.emit('messageCreate', {
    id: 'message-1',
    guildId: 'guild-1',
    channelId: channel.id,
    channel,
    webhookId: null,
    author: { id: 'user-1', bot: false },
    content: 'do not create a task here',
    attachments: new Map(),
    react: async (reaction) => { reactions.push(reaction); },
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(starts, 0);
  assert.deepEqual(reactions, []);
});

test('moving a task channel between its project and archive categories updates the Codex task', async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-discord-controller-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const client = new EventEmitter();
  client.user = { id: 'bot-user' };
  const codex = new EventEmitter();
  const calls = [];
  codex.archiveThread = async (threadId) => { calls.push(['archive', threadId]); };
  codex.unarchiveThread = async (threadId) => { calls.push(['unarchive', threadId]); };
  codex.unsubscribeThread = async (threadId) => { calls.push(['unsubscribe', threadId]); };
  codex.resumeThread = async (threadId) => { calls.push(['resume', threadId]); };

  const binding = {
    threadId: 'thread-1',
    channelId: 'task-channel',
    categoryId: 'project-category',
    projectKey: 'project-1',
    archived: false,
  };
  const stateStore = {
    bindingByChannel: (channelId) => (channelId === binding.channelId ? { ...binding } : null),
    snapshot: () => ({
      infrastructure: { archiveCategoryIds: ['archive-category'] },
      projectCategories: { 'project-1': { categoryIds: ['project-category'] } },
    }),
    setBinding: (threadId, patch) => {
      assert.equal(threadId, binding.threadId);
      Object.assign(binding, patch);
    },
  };
  const controller = new DiscordController({
    client,
    codex,
    stateStore,
    config: { guildId: 'guild-1' },
    logDir: directory,
  });
  controller.attach();

  client.emit('channelUpdate', {
    id: binding.channelId,
    guildId: 'guild-1',
    type: ChannelType.GuildText,
    parentId: 'project-category',
  }, {
    id: binding.channelId,
    guildId: 'guild-1',
    type: ChannelType.GuildText,
    parentId: 'archive-category',
  });
  for (let attempt = 0; attempt < 100 && !binding.archived; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(binding.archived, true);
  assert.equal(binding.categoryId, 'archive-category');
  assert.deepEqual(calls, [
    ['archive', 'thread-1'],
    ['unsubscribe', 'thread-1'],
  ]);

  client.emit('channelUpdate', {
    id: binding.channelId,
    guildId: 'guild-1',
    type: ChannelType.GuildText,
    parentId: 'archive-category',
  }, {
    id: binding.channelId,
    guildId: 'guild-1',
    type: ChannelType.GuildText,
    parentId: 'project-category',
  });
  for (let attempt = 0; attempt < 100 && binding.archived; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(binding.archived, false);
  assert.equal(binding.categoryId, 'project-category');
  assert.deepEqual(calls, [
    ['archive', 'thread-1'],
    ['unsubscribe', 'thread-1'],
    ['unarchive', 'thread-1'],
    ['resume', 'thread-1'],
  ]);
});

test('moving a task channel to an unrelated category rolls it back without changing Codex state', async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-discord-controller-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const client = new EventEmitter();
  client.user = { id: 'bot-user' };
  const codex = new EventEmitter();
  const codexCalls = [];
  codex.archiveThread = async () => { codexCalls.push('archive'); };
  codex.unarchiveThread = async () => { codexCalls.push('unarchive'); };
  codex.unsubscribeThread = async () => { codexCalls.push('unsubscribe'); };
  codex.resumeThread = async () => { codexCalls.push('resume'); };

  const binding = {
    threadId: 'thread-1',
    channelId: 'task-channel',
    categoryId: 'project-category',
    projectKey: 'project-1',
    archived: false,
  };
  const stateStore = {
    bindingByChannel: (channelId) => (channelId === binding.channelId ? { ...binding } : null),
    snapshot: () => ({
      infrastructure: { archiveCategoryIds: ['archive-category'] },
      projectCategories: { 'project-1': { categoryIds: ['project-category'] } },
    }),
    setBinding: (threadId, patch) => {
      assert.equal(threadId, binding.threadId);
      Object.assign(binding, patch);
    },
  };
  const controller = new DiscordController({
    client,
    codex,
    stateStore,
    config: { guildId: 'guild-1' },
    logDir: directory,
  });
  controller.attach();

  const restoredParents = [];
  const movedChannel = {
    id: binding.channelId,
    guildId: 'guild-1',
    type: ChannelType.GuildText,
    parentId: 'unrelated-category',
    setParent: async (parentId) => {
      restoredParents.push(parentId);
      client.emit('channelUpdate', { ...movedChannel }, { ...movedChannel, parentId });
    },
  };
  client.emit('channelUpdate', {
    ...movedChannel,
    parentId: 'project-category',
  }, movedChannel);

  for (let attempt = 0; attempt < 100 && restoredParents.length === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.deepEqual(restoredParents, ['project-category']);
  assert.deepEqual(codexCalls, []);
  assert.equal(binding.archived, false);
  assert.equal(binding.categoryId, 'project-category');
});

test('task file UI browses project entries and resolves assistant-linked files outside project roots', async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-discord-controller-files-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const project = path.join(directory, 'project');
  fs.mkdirSync(project);
  fs.mkdirSync(path.join(project, '.git', 'objects'), { recursive: true });
  const safePath = path.join(project, 'artifact.txt');
  const secretPath = path.join(project, '.env');
  const siblingProject = path.join(directory, 'sibling-project');
  fs.mkdirSync(siblingProject);
  const siblingPath = path.join(siblingProject, 'cross-project.txt');
  const threadId = 'thread-files';
  const codexHome = path.join(directory, '.codex');
  const runtimeRoot = path.join(codexHome, 'visualizations', '2026', '07', '25', threadId);
  fs.mkdirSync(runtimeRoot, { recursive: true });
  const runtimePath = path.join(runtimeRoot, 'runtime-artifact.zip');
  const generatedImageRoot = path.join(codexHome, 'generated_images', threadId);
  fs.mkdirSync(generatedImageRoot, { recursive: true });
  const generatedImagePath = path.join(generatedImageRoot, 'generated-image.png');
  const sessionPath = path.join(directory, 'rollout.jsonl');
  fs.writeFileSync(safePath, 'artifact', 'utf8');
  fs.writeFileSync(secretPath, 'TOKEN=secret', 'utf8');
  fs.writeFileSync(path.join(project, 'archive-payload.bin'), randomBytes(30_000));
  fs.writeFileSync(path.join(project, '.git', 'config'), '[core]\nrepositoryformatversion = 0\n', 'utf8');
  fs.writeFileSync(path.join(project, '.git', 'objects', 'payload.bin'), randomBytes(30_000));
  fs.writeFileSync(siblingPath, 'cross-project', 'utf8');
  fs.writeFileSync(runtimePath, 'runtime-artifact', 'utf8');
  fs.writeFileSync(generatedImagePath, 'generated-image', 'utf8');
  fs.writeFileSync(sessionPath, [
    JSON.stringify({ type: 'session_meta', payload: { id: threadId } }),
    JSON.stringify({ type: 'turn_context', payload: { workspace_roots: [project, runtimeRoot] } }),
  ].join('\n'));

  const client = new EventEmitter();
  client.user = { id: 'bot-user' };
  const codex = new EventEmitter();
  const copyText = `Full assistant card text ${'x'.repeat(1_800)}`;
  const binding = {
    threadId,
    channelId: 'task-channel',
    cwd: project,
    sessionPath,
    turnMessages: {
      'turn-1': {
        assistantEntries: {
          'assistant-1': {
            text: copyText,
            messageIds: ['assistant-card'],
            localFiles: [
              { label: 'cross-project', target: siblingPath },
              { label: 'environment', target: secretPath },
              { label: 'runtime artifact', target: runtimePath },
              { label: 'generated image', target: generatedImagePath },
            ],
          },
        },
      },
    },
  };
  let linkedPickerOrder = null;
  const stateStore = {
    binding: (threadId) => threadId === binding.threadId ? structuredClone(binding) : null,
    bindingByChannel: (channelId) => {
      linkedPickerOrder?.push('binding');
      return channelId === binding.channelId ? structuredClone(binding) : null;
    },
    projectCategories: () => [{ path: project }, { path: siblingProject }],
  };
  const controller = new DiscordController({
    client,
    codex,
    stateStore,
    config: {
      fileShareEnabled: true,
      fileShareChunkBytes: 10_000,
      fileShareMaxBytes: 100_000,
      fileShareAttachmentsPerMessage: 2,
      desktopGlobalStatePath: path.join(codexHome, '.codex-global-state.json'),
      guildId: 'guild-1',
      allowedUserIds: ['user-1'],
    },
    logDir: directory,
  });
  controller.attach();

  const filePosts = [];
  const taskChannel = {
    id: binding.channelId,
    isTextBased: () => true,
    send: async (payload) => {
      const message = {
        id: `file-post-${filePosts.length + 1}`,
        url: `https://discord.test/${filePosts.length + 1}`,
        ...payload,
      };
      filePosts.push(message);
      return message;
    },
  };

  const interaction = (customId, message = null, values = []) => ({
    guildId: 'guild-1',
    channelId: binding.channelId,
    channel: taskChannel,
    user: { id: 'user-1' },
    customId,
    message,
    values,
    deferred: false,
    replied: false,
    isAutocomplete: () => false,
    isChatInputCommand: () => false,
    isStringSelectMenu: () => values.length > 0,
    isButton: () => values.length === 0,
    isModalSubmit: () => false,
    isRepliable: () => true,
    deferReply: async function deferReply(options) { this.deferred = true; this.deferReplyOptions = options; },
    deferUpdate: async function deferUpdate() { this.deferred = true; },
    editReply: async function editReply(payload) { this.lastReply = payload; return payload; },
    reply: async function reply(payload) { this.replied = true; this.lastReply = payload; return payload; },
    followUp: async function followUp(payload) { this.lastFollowUp = payload; return payload; },
  });

  const browser = interaction(`cx:ui:task:file-actions:${binding.threadId}`, null, ['files']);
  client.emit('interactionCreate', browser);
  for (let attempt = 0; attempt < 100 && !browser.lastReply; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(browser.lastReply.embeds[0].toJSON().title, 'Project files');
  const browserOptions = browser.lastReply.components[0].toJSON().components[0].options;
  assert.ok(browserOptions.some((option) => option.label.includes('artifact.txt')));
  assert.match(browserOptions.find((option) => option.label.includes('.env')).description, /ダウンロード/);

  const projectDownload = interaction(`cx:ui:task:file-actions:${binding.threadId}`, null, ['project']);
  client.emit('interactionCreate', projectDownload);
  for (let attempt = 0; attempt < 100 && !projectDownload.lastReply; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.match(projectDownload.lastReply.content, /\.git/);
  assert.match(projectDownload.lastReply.content, /鍵・資格情報/);
  assert.match(projectDownload.lastReply.content, /総量上限は設けず/);
  assert.match(projectDownload.lastReply.content, /以下のvolumeへ分割/);
  assert.doesNotMatch(projectDownload.lastReply.content, /512 MB/);
  assert.match(projectDownload.lastReply.content, /symlink・junction/);
  const projectConfirm = projectDownload.lastReply.components[0].toJSON().components[0];
  assert.match(projectConfirm.custom_id, /^cx:confirm:[^:]+:yes$/);
  assert.equal(projectConfirm.label, 'Archiveを作成');

  const gitDownload = interaction(`cx:ui:task:file-actions:${binding.threadId}`, null, ['git']);
  client.emit('interactionCreate', gitDownload);
  for (let attempt = 0; attempt < 100 && !gitDownload.lastReply; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.match(gitDownload.lastReply.content, /\.git.*だけ/);
  assert.match(gitDownload.lastReply.content, /Git履歴/);
  assert.match(gitDownload.lastReply.content, /通常ファイルは含めません/);
  assert.match(gitDownload.lastReply.content, /総量上限は設けず/);
  assert.match(gitDownload.lastReply.content, /以下のvolumeへ分割/);
  assert.doesNotMatch(gitDownload.lastReply.content, /512 MB/);
  assert.match(gitDownload.lastReply.content, /symlink・junction/);
  const gitConfirm = gitDownload.lastReply.components[0].toJSON().components[0];
  assert.match(gitConfirm.custom_id, /^cx:confirm:[^:]+:yes$/);
  assert.equal(gitConfirm.label, '.gitを作成');

  const copied = interaction('cx:copy:card', {
    id: 'assistant-card',
    embeds: [{
      title: 'Codex message',
      description: 'Full assistant card text...',
      fields: [
        { name: 'Task', value: `\`${binding.threadId}\`` },
        { name: 'Turn', value: '`turn-1`' },
        { name: 'Message', value: '`assistant-1`' },
      ],
    }],
    attachments: new Map(),
  });
  client.emit('interactionCreate', copied);
  for (let attempt = 0; attempt < 100 && !copied.lastReply; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.deepEqual(copied.deferReplyOptions, { ephemeral: true });
  assert.match(copied.lastReply.content, /Full assistant card text/);
  assert.doesNotMatch(copied.lastReply.content, /カード本文/);
  assert.match(copied.lastReply.content, /全文は添付/);
  assert.equal(copied.lastReply.files[0].name, 'codex-card-assistant-card.txt');
  assert.equal(copied.lastReply.files[0].attachment.toString('utf8'), copyText);

  const linked = interaction('cx:files:linked', {
    id: 'assistant-card',
    embeds: [],
  });
  linkedPickerOrder = [];
  linked.deferReply = async function deferReply() {
    linkedPickerOrder.push('defer');
    this.deferred = true;
  };
  client.emit('interactionCreate', linked);
  for (let attempt = 0; attempt < 100 && !linked.lastReply; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.deepEqual(linkedPickerOrder.slice(0, 2), ['binding', 'defer']);
  linkedPickerOrder = null;
  const linkedOptions = linked.lastReply.components[0].toJSON().components[0].options;
  assert.equal(linkedOptions[0].label, 'cross-project');
  assert.equal(linkedOptions[0].emoji.name, '📄');
  assert.equal(linkedOptions[1].label, 'environment');
  assert.equal(linkedOptions[1].emoji.name, '📄');
  assert.equal(linkedOptions[1].description, '.env');
  assert.equal(linkedOptions[2].label, 'runtime artifact');
  assert.equal(linkedOptions[2].emoji.name, '📄');
  assert.equal(linkedOptions[3].label, 'generated image');
  assert.equal(linkedOptions[3].emoji.name, '📄');

  const pickerId = linked.lastReply.components[0].toJSON().components[0].custom_id;
  const download = {
    ...interaction(pickerId),
    values: ['0'],
    isStringSelectMenu: () => true,
    isButton: () => false,
    deferUpdate: async function deferUpdate() { this.deferred = true; },
    followUp: async function followUp(payload) { this.lastFollowUp = payload; return payload; },
  };
  client.emit('interactionCreate', download);
  for (let attempt = 0; attempt < 100 && !download.lastFollowUp; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.match(download.lastFollowUp.content, /https:\/\/discord\.test\/1/);
  assert.equal(filePosts.length, 1);
  assert.equal(filePosts[0].files.length, 1);

  if (discover7Zip()) {
    const zipStart = filePosts.length;
    const zipButton = linked.lastReply.components[1].toJSON().components[0];
    assert.equal(zipButton.custom_id.startsWith('cx:files:linkednav:'), true);
    assert.equal(zipButton.custom_id.endsWith(':download'), true);
    assert.equal(zipButton.label, 'Download all as ZIP (4)');
    const zipDownload = interaction(zipButton.custom_id);
    client.emit('interactionCreate', zipDownload);
    for (let attempt = 0; attempt < 60_000 && !zipDownload.lastFollowUp; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.match(zipDownload.lastFollowUp.content, /https:\/\/discord\.test\//);
    assert.match(filePosts[zipStart].content, /Codex linked files ZIP/);
    assert.doesNotMatch(filePosts[zipStart].content, /Skipped unavailable links/);
    const zipAttachments = filePosts.slice(zipStart).flatMap((post) => post.files ?? []);
    assert.ok(zipAttachments.some((file) => file.name === 'linked-files.zip'));
    assert.ok(zipAttachments.some((file) => file.name === 'linked-files.zip-manifest.json'));

    const projectStart = filePosts.length;
    const confirmedProject = interaction(projectConfirm.custom_id);
    client.emit('interactionCreate', confirmedProject);
    for (let attempt = 0; attempt < 60_000 && !/投稿しました/.test(confirmedProject.lastReply?.content ?? ''); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.match(confirmedProject.lastReply.content, /https:\/\/discord\.test\//);
    assert.match(filePosts[projectStart].content, /Codex project archive/);
    assert.match(filePosts[projectStart].content, /Includes: `\.git`/);
    const volumePosts = filePosts.slice(projectStart + 1, -1);
    assert.ok(volumePosts.length > 1);
    assert.ok(volumePosts.every((post) => post.files?.length === 1));
    const projectAttachments = filePosts.slice(projectStart + 1).flatMap((post) => post.files ?? []);
    assert.ok(projectAttachments.some((file) => file.name.endsWith('.project.7z.001')));
    assert.ok(projectAttachments.some((file) => file.name.endsWith('.project.7z-manifest.json')));

    const gitStart = filePosts.length;
    const confirmedGit = interaction(gitConfirm.custom_id);
    client.emit('interactionCreate', confirmedGit);
    for (let attempt = 0; attempt < 60_000 && !/投稿しました/.test(confirmedGit.lastReply?.content ?? ''); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.match(confirmedGit.lastReply.content, /https:\/\/discord\.test\//);
    assert.match(filePosts[gitStart].content, /Codex \.git archive/);
    assert.match(filePosts[gitStart].content, /Includes only: `project\/\.git`/);
    const gitVolumePosts = filePosts.slice(gitStart + 1, -1);
    assert.ok(gitVolumePosts.length > 1);
    assert.ok(gitVolumePosts.every((post) => post.files?.length === 1));
    const gitAttachments = filePosts.slice(gitStart + 1).flatMap((post) => post.files ?? []);
    assert.ok(gitAttachments.some((file) => file.name.endsWith('.git.7z.001')));
    assert.ok(gitAttachments.some((file) => file.name.endsWith('.git.7z-manifest.json')));
  }
});
