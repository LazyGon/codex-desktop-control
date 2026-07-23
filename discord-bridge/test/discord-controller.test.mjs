import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ChannelType } from 'discord.js';
import { DiscordController } from '../src/discord-controller.mjs';
import { taskPanelMarker } from '../src/discord-panels.mjs';
import { discover7Zip } from '../src/split-archive.mjs';

test('completed turns replace the pinned task panel below the final card exactly once', async (context) => {
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
  client.channels = { fetch: async () => channel };

  const completionMessages = new Map();
  const completions = {
    messages: {
      fetch: async (value) => (typeof value === 'string'
        ? completionMessages.get(value) ?? null
        : collection(completionMessages)),
    },
    send: async (options) => {
      const message = {
        id: `completion-${completionMessages.size + 1}`,
        author: { id: 'bot-user', bot: true },
        content: options.content,
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
      allowedUserIds: ['user-1'],
      completionMentionUserId: 'user-1',
      liveUpdateIntervalMs: 10,
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
  assert.equal(channelMessages.has('panel-old'), false);
  const panel = channelMessages.get(binding.controlPanelMessageId);
  assert.ok(panel);
  assert.equal(panel.pinned, true);
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

  const firstPanelId = panel.id;
  codex.emit('notification', notification);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(binding.controlPanelMessageId, firstPanelId);
  assert.equal([...channelMessages.values()].filter((message) => message.embeds[0]?.footer?.text === taskPanelMarker(binding.threadId)).length, 1);
  if (controller.taskSyncDebounceTimer) clearTimeout(controller.taskSyncDebounceTimer);
});

test('ordinary allowed-user messages in bound task channels are delivered once', async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-discord-controller-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const client = new EventEmitter();
  client.user = { id: 'bot-user' };
  const codex = new EventEmitter();
  let delivered = null;
  let resolveDelivery;
  const delivery = new Promise((resolve) => { resolveDelivery = resolve; });
  codex.deliver = async (threadId, prompt, attachment) => {
    delivered = { threadId, prompt, attachment };
    resolveDelivery();
    setImmediate(() => codex.emit('notification', {
      method: 'item/started',
      params: {
        threadId,
        turnId: 'turn-1',
        item: { type: 'userMessage', id: 'user-item-1', content: [{ type: 'text', text: prompt }] },
      },
    }));
    return { mode: 'steer', turnId: 'turn-1' };
  };
  const turnRecords = new Map();
  const binding = { threadId: 'thread-1', channelId: 'task-channel', cwd: 'C:\\work', watchLevel: 'normal' };
  const stateStore = {
    binding: (threadId) => (threadId === 'thread-1' ? binding : null),
    bindingByChannel: (channelId) => (channelId === 'task-channel' ? binding : null),
    turnRecord: (threadId, turnId) => turnRecords.get(`${threadId}:${turnId}`) ?? null,
    setTurnRecord: (threadId, turnId, patch) => {
      const key = `${threadId}:${turnId}`;
      turnRecords.set(key, { ...turnRecords.get(key), ...patch });
    },
    setBinding: () => {},
  };
  const channelMessages = new Map();
  const sent = [];
  let nextMessage = 1;
  const channel = {
    messages: {
      fetch: async (value) => (typeof value === 'string'
        ? channelMessages.get(value) ?? null
        : Object.assign(new Map(channelMessages), {
          last: () => [...channelMessages.values()].at(-1) ?? null,
        })),
    },
    send: async (options) => {
      const message = {
        id: `bot-message-${nextMessage++}`,
        author: { id: 'bot-user', bot: true },
        content: options.content ?? '',
        embeds: (options.embeds ?? []).map((embed) => embed.toJSON()),
        components: (options.components ?? []).map((component) => component.toJSON?.() ?? component),
        attachments: new Map(),
        edit: async (next) => {
          message.content = next.content ?? message.content;
          if (next.embeds) message.embeds = next.embeds.map((embed) => embed.toJSON?.() ?? embed);
          if (next.components) message.components = next.components.map((component) => component.toJSON?.() ?? component);
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
      liveUpdateIntervalMs: 100,
    },
    logDir: directory,
  });
  controller.attach();

  const reactions = [];
  const replies = [];
  let originalDeleted = false;
  const originalMessage = {
    id: 'message-1',
    guildId: 'guild-1',
    channelId: 'task-channel',
    webhookId: null,
    author: { id: 'user-1', tag: 'user#0001', bot: false },
    content: 'run the requested task',
    attachments: new Map(),
    reactions: { resolve: () => null },
    react: async (reaction) => { reactions.push(reaction); },
    reply: async (options) => { replies.push(options); },
    delete: async () => { originalDeleted = true; channelMessages.delete('message-1'); },
  };
  channelMessages.set(originalMessage.id, originalMessage);
  client.emit('messageCreate', originalMessage);

  await delivery;
  for (let attempt = 0; attempt < 50 && !reactions.includes('✅'); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.deepEqual(delivered, { threadId: 'thread-1', prompt: 'run the requested task', attachment: null });
  assert.deepEqual(reactions, ['⏳', '✅'], JSON.stringify(replies));
  assert.deepEqual(replies, []);
  assert.equal(originalDeleted, true);
  const userCard = sent.find((message) => message.embeds[0]?.title === 'User message');
  assert.ok(userCard);
  assert.equal(userCard.embeds[0].color, 0xe67e22);
  assert.equal(userCard.embeds[0].description, 'run the requested task');
  assert.deepEqual(userCard.embeds[0].fields.map((field) => field.name), ['Task', 'Turn', 'Message']);
  assert.deepEqual(turnRecords.get('thread-1:turn-1').userMessageIds, [userCard.id]);
  assert.deepEqual(turnRecords.get('thread-1:turn-1').userEntries['user-item-1'].messageIds, [userCard.id]);
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
      delta: 'first update [artifact](C:\\work\\artifact.txt)',
    },
  });
  codex.emit('notification', {
    method: 'item/completed',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: { type: 'agentMessage', id: 'assistant-item-1', phase: 'commentary', text: 'first update [artifact](C:\\work\\artifact.txt)' },
    },
  });
  for (let attempt = 0; attempt < 100
    && turnRecords.get('thread-1:turn-1')?.assistantEntries?.['assistant-item-1']?.text !== 'first update [artifact](C:\\work\\artifact.txt)'; attempt += 1) {
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
  assert.equal(pastAssistant.embeds[0].description, 'first update [artifact](C:\\work\\artifact.txt)');
  assert.equal(pastAssistant.components[0].components[0].custom_id, 'cx:files:linked');
  assert.deepEqual(pastAssistant.embeds[0].fields.map((field) => field.name), ['Task', 'Turn', 'Message']);
  assert.equal(liveAssistant.embeds[0].fields.find((field) => field.name === 'Message').value, '`assistant-item-2`');
  assert.deepEqual(turnRecords.get('thread-1:turn-1').assistantEntries['assistant-item-1'].messageIds, [pastAssistant.id]);
  assert.equal(turnRecords.get('thread-1:turn-1').assistantEntries['assistant-item-1'].localFiles[0].target, 'C:\\work\\artifact.txt');
  assert.deepEqual(turnRecords.get('thread-1:turn-1').assistantEntries['assistant-item-2'].messageIds, [liveAssistant.id]);
  assert.equal(new Set(turnRecords.get('thread-1:turn-1').assistantMessageIds).size, 2);
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

test('task Controls button opens catalog-backed UI and confirms permission changes', async (context) => {
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
    customId: `cx:ui:task:controls:${binding.threadId}`,
    isButton: () => true,
    isStringSelectMenu: () => false,
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

test('task file UI browses project entries and resolves only safe assistant-linked files', async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-discord-controller-files-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const project = path.join(directory, 'project');
  fs.mkdirSync(project);
  const safePath = path.join(project, 'artifact.txt');
  const secretPath = path.join(project, '.env');
  const siblingProject = path.join(directory, 'sibling-project');
  fs.mkdirSync(siblingProject);
  const siblingPath = path.join(siblingProject, 'cross-project.txt');
  fs.writeFileSync(safePath, 'artifact', 'utf8');
  fs.writeFileSync(secretPath, 'TOKEN=secret', 'utf8');
  fs.writeFileSync(path.join(project, 'archive-payload.bin'), randomBytes(30_000));
  fs.writeFileSync(siblingPath, 'cross-project', 'utf8');

  const client = new EventEmitter();
  client.user = { id: 'bot-user' };
  const codex = new EventEmitter();
  const binding = {
    threadId: 'thread-files',
    channelId: 'task-channel',
    cwd: project,
    turnMessages: {
      'turn-1': {
        assistantEntries: {
          'assistant-1': {
            messageIds: ['assistant-card'],
            localFiles: [
              { label: 'cross-project', target: siblingPath },
              { label: 'environment', target: secretPath },
            ],
          },
        },
      },
    },
  };
  const stateStore = {
    binding: (threadId) => threadId === binding.threadId ? structuredClone(binding) : null,
    bindingByChannel: (channelId) => channelId === binding.channelId ? structuredClone(binding) : null,
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

  const interaction = (customId, message = null) => ({
    guildId: 'guild-1',
    channelId: binding.channelId,
    channel: taskChannel,
    user: { id: 'user-1' },
    customId,
    message,
    deferred: false,
    replied: false,
    isAutocomplete: () => false,
    isChatInputCommand: () => false,
    isStringSelectMenu: () => false,
    isButton: () => true,
    isModalSubmit: () => false,
    isRepliable: () => true,
    deferReply: async function deferReply() { this.deferred = true; },
    deferUpdate: async function deferUpdate() { this.deferred = true; },
    editReply: async function editReply(payload) { this.lastReply = payload; return payload; },
    reply: async function reply(payload) { this.replied = true; this.lastReply = payload; return payload; },
    followUp: async function followUp(payload) { this.lastFollowUp = payload; return payload; },
  });

  const browser = interaction(`cx:ui:task:files:${binding.threadId}`);
  client.emit('interactionCreate', browser);
  for (let attempt = 0; attempt < 100 && !browser.lastReply; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(browser.lastReply.embeds[0].toJSON().title, 'Project files');
  const browserOptions = browser.lastReply.components[0].toJSON().components[0].options;
  assert.ok(browserOptions.some((option) => option.label.includes('artifact.txt')));
  assert.match(browserOptions.find((option) => option.label.includes('.env')).description, /取得不可/);

  const projectDownload = interaction(`cx:ui:task:project:${binding.threadId}`);
  client.emit('interactionCreate', projectDownload);
  for (let attempt = 0; attempt < 100 && !projectDownload.lastReply; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.match(projectDownload.lastReply.content, /\.git/);
  assert.match(projectDownload.lastReply.content, /鍵・資格情報/);
  assert.match(projectDownload.lastReply.content, /symlink・junction/);
  const projectConfirm = projectDownload.lastReply.components[0].toJSON().components[0];
  assert.match(projectConfirm.custom_id, /^cx:confirm:[^:]+:yes$/);
  assert.equal(projectConfirm.label, 'Archiveを作成');

  const linked = interaction('cx:files:linked', {
    id: 'assistant-card',
    embeds: [],
  });
  client.emit('interactionCreate', linked);
  for (let attempt = 0; attempt < 100 && !linked.lastReply; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const linkedOptions = linked.lastReply.components[0].toJSON().components[0].options;
  assert.equal(linkedOptions[0].label, 'cross-project');
  assert.equal(linkedOptions[0].emoji.name, '📄');
  assert.equal(linkedOptions[1].label, 'environment');
  assert.equal(linkedOptions[1].emoji.name, '🔒');
  assert.match(linkedOptions[1].description, /取得不可/);

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
    assert.equal(zipButton.label, 'Download all as ZIP (1)');
    const zipDownload = interaction(zipButton.custom_id);
    client.emit('interactionCreate', zipDownload);
    for (let attempt = 0; attempt < 200 && !zipDownload.lastFollowUp; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.match(zipDownload.lastFollowUp.content, /https:\/\/discord\.test\//);
    assert.match(filePosts[zipStart].content, /Codex linked files ZIP/);
    assert.match(filePosts[zipStart].content, /Skipped unavailable links: 1/);
    const zipAttachments = filePosts.slice(zipStart).flatMap((post) => post.files ?? []);
    assert.ok(zipAttachments.some((file) => file.name === 'linked-files.zip'));
    assert.ok(zipAttachments.some((file) => file.name === 'linked-files.zip-manifest.json'));

    const projectStart = filePosts.length;
    const confirmedProject = interaction(projectConfirm.custom_id);
    client.emit('interactionCreate', confirmedProject);
    for (let attempt = 0; attempt < 200 && !/投稿しました/.test(confirmedProject.lastReply?.content ?? ''); attempt += 1) {
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
  }
});
