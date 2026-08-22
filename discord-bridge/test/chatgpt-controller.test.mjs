import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { ChannelType } from 'discord.js';
import { ChatgptController } from '../src/chatgpt-controller.mjs';
import { StateStore } from '../src/state-store.mjs';

const CONVERSATION_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function fakeDiscordMessage(id, channel, authorId = 'authorized-user') {
  const reactions = new Map();
  return {
    id,
    guildId: 'guild-1',
    channelId: channel.id,
    channel,
    author: { id: authorId, bot: false },
    webhookId: null,
    content: 'hello from Discord',
    attachments: new Map(),
    reactions: {
      resolve: (emoji) => reactions.get(emoji) ?? null,
    },
    react: async (emoji) => {
      reactions.set(emoji, { users: { remove: async () => reactions.delete(emoji) } });
    },
    reply: async (payload) => channel.send(payload),
  };
}

function fakeTextChannel(id, botId) {
  let nextId = 1;
  const messages = new Map();
  const channel = {
    id,
    type: ChannelType.GuildText,
    name: '⚫-explicit-chat',
    parentId: 'chatgpt-category',
    permissionsLocked: true,
    async setName(name) { this.name = name; return this; },
    async setParent(parentId) { this.parentId = parentId; return this; },
    async lockPermissions() { this.permissionsLocked = true; return this; },
    messages: {
      fetch: async (selector) => {
        if (typeof selector === 'string') return messages.get(selector) ?? null;
        return new Map([...messages.entries()].slice(-Number(selector?.limit ?? 100)));
      },
    },
    async send(payload) {
      const messageId = `bot-message-${nextId++}`;
      const message = {
        id: messageId,
        author: { id: botId },
        embeds: payload.embeds ?? [],
        components: payload.components ?? [],
        pinned: false,
        async edit(next) {
          this.embeds = next.embeds ?? [];
          this.components = next.components ?? [];
          return this;
        },
        async pin() { this.pinned = true; return this; },
        async delete() { messages.delete(messageId); },
      };
      messages.set(messageId, message);
      return message;
    },
    _messages: messages,
  };
  return channel;
}

async function waitForRecord(store, state, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const record = store.chatgptMessageRecord(CONVERSATION_ID, 'discord-message-1');
    if (record?.state === state) return record;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${state}.`);
}

test('linked ChatGPT channel delivers a duplicated Discord event exactly once', async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chatgpt-controller-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const stateStore = new StateStore(directory, 'guild-1');
  const channel = fakeTextChannel('chat-channel-1', 'bot-user');
  stateStore.setChatgptConversation(CONVERSATION_ID, {
    channelId: channel.id,
    name: 'Explicit chat',
    conversationUrl: `https://chatgpt.com/c/${CONVERSATION_ID}`,
    responsePerformance: 'fastest',
  });

  const client = new EventEmitter();
  client.user = { id: 'bot-user' };
  client.channels = { fetch: async (id) => id === channel.id ? channel : null };
  let sends = 0;
  const service = {
    activeCount: 0,
    async send(options) {
      sends += 1;
      this.activeCount += 1;
      options.onText?.('partial');
      this.activeCount -= 1;
      return {
        requestMessageId: 'request-1',
        assistantMessageId: 'assistant-1',
        assistantText: 'answer',
        assistantAttachments: [],
      };
    },
    async stop() {},
  };
  const controller = new ChatgptController({
    client,
    service,
    stateStore,
    config: {
      guildId: 'guild-1',
      chatgptEnabled: true,
      authorizedUserIds: ['authorized-user'],
      inputAttachmentMaxBytes: 1_000_000,
      inputAttachmentTotalMaxBytes: 1_000_000,
      inputAttachmentMaxCount: 10,
      discordRestTimeoutMs: 300_000,
      chatgptLiveUpdateIntervalMs: 1_000,
    },
    logDir: directory,
    incomingAttachmentStore: { store: async () => [] },
  });
  controller.attach();
  const incoming = fakeDiscordMessage('discord-message-1', channel);
  client.emit('messageCreate', incoming);
  client.emit('messageCreate', incoming);

  const record = await waitForRecord(stateStore, 'completed');
  assert.equal(sends, 1);
  assert.equal(record.requestMessageId, 'request-1');
  assert.equal(record.assistantMessageId, 'assistant-1');
  assert.equal(record.responseMessageIds.length, 1);
  assert.equal(channel.name, '⚫-explicit-chat');
  await controller.stop();
});

test('structured reviewer-accessor submission status controls safe retry classification', async (context) => {
  for (const scenario of [
    { submissionStatus: 'NOT_STARTED', expectedState: 'failed', expectedSubmitted: false },
    { submissionStatus: 'POSSIBLE', expectedState: 'uncertain', expectedSubmitted: null },
    { submissionStatus: 'CONFIRMED', expectedState: 'uncertain', expectedSubmitted: true },
  ]) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), `chatgpt-controller-${scenario.submissionStatus}-`));
    context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const stateStore = new StateStore(directory, 'guild-1');
    const channel = fakeTextChannel('chat-channel-1', 'bot-user');
    stateStore.setChatgptConversation(CONVERSATION_ID, {
      channelId: channel.id,
      name: 'Explicit chat',
      conversationUrl: `https://chatgpt.com/c/${CONVERSATION_ID}`,
      responsePerformance: 'fastest',
    });
    const client = new EventEmitter();
    client.user = { id: 'bot-user' };
    client.channels = { fetch: async () => channel };
    const service = {
      activeCount: 0,
      async send() {
        throw Object.assign(new Error('safe public failure'), {
          code: 'DISCORD_CHAT_FIXTURE',
          submissionStatus: scenario.submissionStatus,
        });
      },
      async stop() {},
    };
    const controller = new ChatgptController({
      client,
      service,
      stateStore,
      config: {
        guildId: 'guild-1',
        chatgptEnabled: true,
        authorizedUserIds: ['authorized-user'],
        inputAttachmentMaxBytes: 1_000_000,
        inputAttachmentTotalMaxBytes: 1_000_000,
        inputAttachmentMaxCount: 10,
        discordRestTimeoutMs: 300_000,
        chatgptLiveUpdateIntervalMs: 1_000,
      },
      logDir: directory,
      incomingAttachmentStore: { store: async () => [] },
    });
    controller.attach();
    client.emit('messageCreate', fakeDiscordMessage('discord-message-1', channel));
    const record = await waitForRecord(stateStore, scenario.expectedState);
    assert.equal(record.submitted, scenario.expectedSubmitted);
    assert.equal(record.submissionStatus, scenario.submissionStatus);
    const response = channel._messages.get(record.liveMessageId);
    const description = response.embeds[0].data?.description ?? response.embeds[0].description;
    assert.match(description, /DISCORD_CHAT_FIXTURE/);
    assert.doesNotMatch(description, /safe public failure/);
    await controller.stop();
  }
});

test('ordinary Discord messages outside explicitly linked ChatGPT channels are ignored', async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chatgpt-controller-ignore-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const stateStore = new StateStore(directory, 'guild-1');
  const channel = fakeTextChannel('unlinked-channel', 'bot-user');
  const client = new EventEmitter();
  client.user = { id: 'bot-user' };
  client.channels = { fetch: async () => channel };
  let sends = 0;
  const controller = new ChatgptController({
    client,
    service: { activeCount: 0, send: async () => { sends += 1; }, stop: async () => {} },
    stateStore,
    config: {
      guildId: 'guild-1',
      chatgptEnabled: true,
      authorizedUserIds: ['authorized-user'],
      inputAttachmentMaxBytes: 1_000_000,
      inputAttachmentTotalMaxBytes: 1_000_000,
      inputAttachmentMaxCount: 10,
      discordRestTimeoutMs: 300_000,
      chatgptLiveUpdateIntervalMs: 1_000,
    },
    logDir: directory,
    incomingAttachmentStore: { store: async () => [] },
  });
  controller.attach();
  client.emit('messageCreate', fakeDiscordMessage('discord-message-1', channel));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sends, 0);
  assert.equal(stateStore.chatgptConversations().length, 0);
  await controller.stop();
});

test('/chatgpt link is the explicit operation that creates and persists a listed channel', async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chatgpt-controller-link-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const stateStore = new StateStore(directory, 'guild-1');
  const control = fakeTextChannel('chatgpt-control', 'bot-user');
  control.parentId = 'control-category';
  const created = [];
  const guild = {
    channels: {
      create: async (options) => {
        const channel = fakeTextChannel(`created-${created.length + 1}`, 'bot-user');
        channel.name = options.name;
        channel.parentId = options.parent;
        channel.topic = options.topic;
        created.push(channel);
        return channel;
      },
    },
  };
  const client = new EventEmitter();
  client.user = { id: 'bot-user' };
  client.channels = {
    fetch: async (id) => [control, ...created].find((channel) => channel.id === id) ?? null,
  };
  const service = {
    activeCount: 0,
    identity: async (conversationUrl) => ({
      conversationId: CONVERSATION_ID,
      conversationUrl,
    }),
    stop: async () => {},
  };
  const controller = new ChatgptController({
    client,
    service,
    stateStore,
    config: {
      guildId: 'guild-1',
      chatgptEnabled: true,
      authorizedUserIds: ['authorized-user'],
      reviewerAccessorResponsePerformance: 'fastest',
      inputAttachmentMaxBytes: 1_000_000,
      inputAttachmentTotalMaxBytes: 1_000_000,
      inputAttachmentMaxCount: 10,
      discordRestTimeoutMs: 300_000,
      chatgptLiveUpdateIntervalMs: 1_000,
    },
    logDir: directory,
    incomingAttachmentStore: { store: async () => [] },
  });
  controller.infrastructure = {
    guild,
    category: { id: 'chatgpt-category' },
    control,
  };
  controller.attach();
  let reply = null;
  const interaction = {
    commandName: 'chatgpt',
    customId: null,
    guildId: 'guild-1',
    user: { id: 'authorized-user' },
    isChatInputCommand: () => true,
    options: {
      getSubcommand: () => 'link',
      getString: (name) => ({
        url: `https://chatgpt.com/c/${CONVERSATION_ID}`,
        name: 'Explicit command chat',
        performance: 'pro',
      })[name] ?? null,
    },
    deferReply: async () => {},
    editReply: async (payload) => { reply = payload; },
    reply: async () => {},
    followUp: async () => {},
  };
  client.emit('interactionCreate', interaction);
  const deadline = Date.now() + 2_000;
  while (!reply && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const conversation = stateStore.chatgptConversation(CONVERSATION_ID);
  assert.equal(conversation.name, 'Explicit command chat');
  assert.equal(conversation.responsePerformance, 'pro');
  assert.equal(created.length, 1);
  assert.equal(created[0].parentId, 'chatgpt-category');
  assert.match(reply.content, new RegExp(`<#${created[0].id}>`));
  await controller.stop();
});
