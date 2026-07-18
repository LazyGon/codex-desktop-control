import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ChannelType } from 'discord.js';
import { DiscordController } from '../src/discord-controller.mjs';

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
      delta: 'first update',
    },
  });
  codex.emit('notification', {
    method: 'item/completed',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: { type: 'agentMessage', id: 'assistant-item-1', phase: 'commentary', text: 'first update' },
    },
  });
  for (let attempt = 0; attempt < 100
    && turnRecords.get('thread-1:turn-1')?.assistantEntries?.['assistant-item-1']?.text !== 'first update'; attempt += 1) {
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
  assert.equal(pastAssistant.embeds[0].description, 'first update');
  assert.deepEqual(pastAssistant.embeds[0].fields.map((field) => field.name), ['Task', 'Turn', 'Message']);
  assert.equal(liveAssistant.embeds[0].fields.find((field) => field.name === 'Message').value, '`assistant-item-2`');
  assert.deepEqual(turnRecords.get('thread-1:turn-1').assistantEntries['assistant-item-1'].messageIds, [pastAssistant.id]);
  assert.deepEqual(turnRecords.get('thread-1:turn-1').assistantEntries['assistant-item-2'].messageIds, [liveAssistant.id]);
  assert.equal(new Set(turnRecords.get('thread-1:turn-1').assistantMessageIds).size, 2);
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
