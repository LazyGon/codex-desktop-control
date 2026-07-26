import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ChannelType } from 'discord.js';
import { DiscordController } from '../src/discord-controller.mjs';
import { CONTROL_PANEL_COLOR, taskPanelMarker } from '../src/discord-panels.mjs';
import { discover7Zip } from '../src/split-archive.mjs';

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
  assert.equal(sent[finalIndex].embeds[0].color, 0x1971c2);
  assert.equal(sent[finalIndex].components[0].components.at(-1).custom_id, 'cx:copy:card');
  assert.equal(binding.turnMessages['turn-complete'].finalText, 'Finished.');
  const completionNotice = [...completionMessages.values()][0];
  assert.equal(
    completionNotice.content,
    `<@subscriber-user> <@executor-user> タスクが完了しました。\n要約: Finished.\n${sent[finalIndex].url}`,
  );
  assert.deepEqual(completionNotice.allowedMentions, {
    parse: [],
    users: ['subscriber-user', 'executor-user'],
  });
  assert.equal(panel.embeds[0].color, CONTROL_PANEL_COLOR);
  assert.notEqual(sent[finalIndex].embeds[0].color, panel.embeds[0].color);

  const firstPanelId = panel.id;
  codex.emit('notification', notification);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(binding.controlPanelMessageId, firstPanelId);
  assert.equal([...channelMessages.values()].filter((message) => message.embeds[0]?.footer?.text === taskPanelMarker(binding.threadId)).length, 1);

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
    customId: `cx:ui:task:completion:${thread.id}`,
    values: ['disabled'],
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
  const completionSelect = panel.components[4].toJSON().components[0];
  assert.equal(completionSelect.options.find((option) => option.default).value, 'disabled');

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

test('ordinary allowed-user messages in bound task channels are delivered once', async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-discord-controller-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));

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
      authorizedUserIds: ['user-1'],
      liveUpdateIntervalMs: 100,
    },
    logDir: directory,
    incomingAttachmentStore,
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
  assert.equal(userCard.embeds[0].color, 0xe67e22);
  assert.equal(userCard.embeds[0].description, 'run the requested task');
  assert.equal(userCard.components[0].components[0].custom_id, 'cx:copy:card');
  assert.deepEqual(userCard.embeds[0].fields.map((field) => field.name), ['Task', 'Turn', 'Message']);
  assert.equal(
    userCard.embeds[0].fields.find((field) => field.name === 'Message').value,
    `\`${delivered.clientUserMessageId}\``,
  );
  assert.deepEqual(turnRecords.get('thread-1:turn-1').userMessageIds, [userCard.id]);
  assert.deepEqual(turnRecords.get('thread-1:turn-1').executorUserIds, ['user-1']);
  assert.deepEqual(
    turnRecords.get('thread-1:turn-1').userEntries[delivered.clientUserMessageId].messageIds,
    [userCard.id],
  );

  const unauthorizedReplies = [];
  const unauthorizedMessage = {
    ...originalMessage,
    id: 'message-unauthorized',
    author: { id: 'user-2', tag: 'other#0002', bot: false },
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
    && !turnRecords.get('thread-1:turn-1')?.userEntries?.['user-item-1']; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.deepEqual(turnRecords.get('thread-1:turn-1').userEntries['user-item-1'].messageIds, [userCard.id]);
  assert.equal(turnRecords.get('thread-1:turn-1').userEntries[delivered.clientUserMessageId], undefined);
  assert.equal(
    userCard.embeds[0].fields.find((field) => field.name === 'Message').value,
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
  assert.equal(pastAssistant.components[0].components[1].custom_id, 'cx:copy:card');
  assert.equal(liveAssistant.components[0].components.at(-1).custom_id, 'cx:copy:card');
  assert.deepEqual(pastAssistant.embeds[0].fields.map((field) => field.name), ['Task', 'Turn', 'Message']);
  assert.equal(liveAssistant.embeds[0].fields.find((field) => field.name === 'Message').value, '`assistant-item-2`');
  assert.deepEqual(turnRecords.get('thread-1:turn-1').assistantEntries['assistant-item-1'].messageIds, [pastAssistant.id]);
  assert.equal(turnRecords.get('thread-1:turn-1').assistantEntries['assistant-item-1'].localFiles[0].target, 'C:\\work\\artifact.txt');
  assert.deepEqual(turnRecords.get('thread-1:turn-1').assistantEntries['assistant-item-2'].messageIds, [liveAssistant.id]);
  assert.equal(new Set(turnRecords.get('thread-1:turn-1').assistantMessageIds).size, 2);
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
    deferReply: async function deferReply(options) { this.deferred = true; this.deferReplyOptions = options; },
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
  assert.match(projectDownload.lastReply.content, /総量上限は設けず/);
  assert.match(projectDownload.lastReply.content, /以下のvolumeへ分割/);
  assert.doesNotMatch(projectDownload.lastReply.content, /512 MB/);
  assert.match(projectDownload.lastReply.content, /symlink・junction/);
  const projectConfirm = projectDownload.lastReply.components[0].toJSON().components[0];
  assert.match(projectConfirm.custom_id, /^cx:confirm:[^:]+:yes$/);
  assert.equal(projectConfirm.label, 'Archiveを作成');

  const gitDownload = interaction(`cx:ui:task:git:${binding.threadId}`);
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
  assert.deepEqual(linkedPickerOrder.slice(0, 2), ['defer', 'binding']);
  linkedPickerOrder = null;
  const linkedOptions = linked.lastReply.components[0].toJSON().components[0].options;
  assert.equal(linkedOptions[0].label, 'cross-project');
  assert.equal(linkedOptions[0].emoji.name, '📄');
  assert.equal(linkedOptions[1].label, 'environment');
  assert.equal(linkedOptions[1].emoji.name, '🔒');
  assert.match(linkedOptions[1].description, /取得不可/);
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
    assert.equal(zipButton.label, 'Download all as ZIP (3)');
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

    const gitStart = filePosts.length;
    const confirmedGit = interaction(gitConfirm.custom_id);
    client.emit('interactionCreate', confirmedGit);
    for (let attempt = 0; attempt < 200 && !/投稿しました/.test(confirmedGit.lastReply?.content ?? ''); attempt += 1) {
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
