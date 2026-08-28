import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { ChannelType } from 'discord.js';
import {
  ChatgptController,
  chatgptHistoryTurnPayloads,
  chatgptLiveRecordForHistoryTurn,
  chatgptReturnedFilePayloads,
} from '../src/chatgpt-controller.mjs';
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
        content: payload.content ?? '',
        embeds: payload.embeds ?? [],
        components: payload.components ?? [],
        files: payload.files ?? [],
        pinned: false,
        async edit(next) {
          this.content = next.content ?? '';
          this.embeds = next.embeds ?? [];
          this.components = next.components ?? [];
          this.files = next.files ?? [];
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

function returnedFileMaterialization(outputRoot, files) {
  return {
    schemaVersion: 1,
    kind: 'reviewer-accessor.discord-returned-file-materialization',
    status: files.some((file) => file.materialization.status === 'UNAVAILABLE') ? 'PARTIAL' : 'COMPLETE',
    outputRoot,
    cleanupOwner: 'caller',
    files,
  };
}

test('materialized ChatGPT images and files become separate Discord attachments without silent omission', async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chatgpt-returned-files-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const imagePath = path.join(directory, 'preview.png');
  const reportPath = path.join(directory, 'report.zip');
  fs.writeFileSync(imagePath, Buffer.from('image-bytes'));
  fs.writeFileSync(reportPath, Buffer.from('report-bytes'));
  const ready = (name, filePath, contentType) => ({
    descriptor: { name, mimeType: contentType },
    materialization: {
      status: 'READY',
      code: null,
      path: filePath,
      sizeBytes: fs.statSync(filePath).size,
      sha256: createHash('sha256').update(fs.readFileSync(filePath)).digest('hex'),
      contentType,
    },
  });
  const materialization = returnedFileMaterialization(directory, [
    ready('preview.png', imagePath, 'image/png'),
    ready('report.zip', reportPath, 'application/zip'),
    {
      descriptor: { name: 'missing.pdf', mimeType: 'application/pdf' },
      materialization: {
        status: 'UNAVAILABLE',
        code: 'RETURNED_FILE_CONTENT_UNAVAILABLE',
        path: null,
        sizeBytes: null,
        sha256: null,
        contentType: null,
      },
    },
  ]);

  const result = await chatgptReturnedFilePayloads(materialization, {
    expectedOutputRoot: directory,
  });
  assert.equal(result.readyCount, 2);
  assert.equal(result.unavailableCount, 1);
  assert.equal(result.cleanupAllowed, true);
  assert.equal(result.payloads[0].content.startsWith('**ChatGPT image**'), true);
  assert.equal(result.payloads[0].files[0].name, 'preview.png');
  assert.equal(result.payloads[1].content.startsWith('**ChatGPT file**'), true);
  assert.equal(result.payloads[1].files[0].name, 'report.zip');
  const unavailableEmbed = result.payloads[2].embeds[0].toJSON();
  assert.match(unavailableEmbed.description, /missing\.pdf/);
  assert.match(unavailableEmbed.description, /RETURNED_FILE_CONTENT_UNAVAILABLE/);
});

test('returned-file paths outside the caller root are rejected and retained for diagnosis', async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chatgpt-returned-root-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'chatgpt-returned-outside-'));
  context.after(() => {
    fs.rmSync(directory, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });
  const outsidePath = path.join(outside, 'outside.png');
  fs.writeFileSync(outsidePath, Buffer.from('outside'));
  const result = await chatgptReturnedFilePayloads(returnedFileMaterialization(directory, [{
    descriptor: { name: 'outside.png', mimeType: 'image/png' },
    materialization: {
      status: 'READY',
      code: null,
      path: outsidePath,
      sizeBytes: 7,
      sha256: createHash('sha256').update('outside').digest('hex'),
      contentType: 'image/png',
    },
  }]), { expectedOutputRoot: directory });
  assert.equal(result.readyCount, 0);
  assert.equal(result.unavailableCount, 1);
  assert.equal(result.cleanupAllowed, false);
  assert.match(result.payloads[0].embeds[0].toJSON().description, /BRIDGE_RETURNED_FILE_INVALID/);
});

test('history payloads preserve long exact text as Markdown and identify already-live turns', () => {
  const turn = {
    turnId: `dht_${'a'.repeat(64)}`,
    status: 'COMPLETED',
    incompleteReason: null,
    user: { messageId: 'request-1', text: 'u'.repeat(3_000), attachments: [] },
    assistantFinal: { messageId: 'assistant-1', text: 'answer', attachments: [] },
  };
  const payloads = chatgptHistoryTurnPayloads(turn);
  assert.equal(payloads.length, 2);
  assert.equal(payloads[0].files[0].attachment.length, 3_000);
  assert.match(payloads[0].files[0].name, /chatgpt-history-user/);
  assert.ok(payloads[0].content.length <= 2_000);
  assert.equal(payloads[1].content, '**ChatGPT · synced history**\nanswer');
  const live = chatgptLiveRecordForHistoryTurn({
    messageRecords: {
      'discord-user-1': {
        state: 'completed',
        requestMessageId: 'request-1',
        assistantMessageId: 'assistant-1',
        responseMessageIds: ['discord-assistant-1'],
      },
    },
  }, turn);
  assert.equal(live[0], 'discord-user-1');
  assert.equal(live[1].responseMessageIds[0], 'discord-assistant-1');
});

test('manual recent-history sync updates the stable turn projection instead of duplicating it', async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chatgpt-history-sync-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const stateStore = new StateStore(directory, 'guild-1');
  const channel = fakeTextChannel('chat-channel-1', 'bot-user');
  stateStore.setChatgptConversation(CONVERSATION_ID, {
    channelId: channel.id,
    name: 'History chat',
    conversationUrl: `https://chatgpt.com/c/${CONVERSATION_ID}`,
    responsePerformance: 'fastest',
  });
  const historyTurn = {
    turnId: `dht_${'b'.repeat(64)}`,
    turnExchangeId: null,
    status: 'INCOMPLETE',
    incompleteReason: 'DURABLE_FINAL_MISSING',
    user: { messageId: 'history-user-1', text: 'question', attachments: [] },
    assistantFinal: null,
  };
  const client = new EventEmitter();
  client.user = { id: 'bot-user' };
  client.channels = { fetch: async () => channel };
  const service = {
    activeCount: 0,
    async readHistory() {
      return {
        schemaVersion: 1,
        kind: 'reviewer-accessor.discord-chat-history',
        conversationId: CONVERSATION_ID,
        limit: 5,
        turns: [structuredClone(historyTurn)],
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

  const sync = async () => {
    let reply = null;
    const interaction = {
      customId: `cg:history:${CONVERSATION_ID}`,
      commandName: null,
      guildId: 'guild-1',
      channelId: channel.id,
      channel,
      user: { id: 'authorized-user' },
      isChatInputCommand: () => false,
      deferReply: async () => {},
      editReply: async (payload) => { reply = payload; },
      reply: async (payload) => { reply = payload; },
      followUp: async (payload) => { reply = payload; },
    };
    client.emit('interactionCreate', interaction);
    const deadline = Date.now() + 2_000;
    while (!reply && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(reply);
    return reply;
  };

  const firstReply = await sync();
  assert.match(firstReply.content, /新規表示: 1/);
  const first = stateStore.chatgptHistoryRecord(CONVERSATION_ID, historyTurn.turnId);
  assert.equal(first.status, 'INCOMPLETE');
  assert.equal(channel._messages.get(first.discordUserMessageId).content, '**You · synced history**\nquestion');
  assert.match(channel._messages.get(first.discordAssistantMessageId).content, /まだありません/);

  historyTurn.status = 'COMPLETED';
  historyTurn.incompleteReason = null;
  historyTurn.assistantFinal = { messageId: 'history-assistant-1', text: 'final answer', attachments: [] };
  const secondReply = await sync();
  assert.match(secondReply.content, /更新: 1/);
  const second = stateStore.chatgptHistoryRecord(CONVERSATION_ID, historyTurn.turnId);
  assert.equal(second.discordUserMessageId, first.discordUserMessageId);
  assert.equal(second.discordAssistantMessageId, first.discordAssistantMessageId);
  assert.equal(second.status, 'COMPLETED');
  assert.equal(channel._messages.get(second.discordAssistantMessageId).content, '**ChatGPT · synced history**\nfinal answer');
  await controller.stop();
});

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
  let returnedFileOutputRoot = null;
  const service = {
    activeCount: 0,
    async send(options) {
      sends += 1;
      returnedFileOutputRoot = options.returnedFileOutputRoot;
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
  assert.equal(path.isAbsolute(returnedFileOutputRoot), true);
  assert.equal(record.returnedFileCleanup, 'removed');
  assert.equal(record.returnedFileOutputRoot, null);
  assert.equal(fs.existsSync(returnedFileOutputRoot), false);
  assert.equal(channel.name, '⚫-explicit-chat');
  await controller.stop();
});

test('a materialized returned image is posted by the controller and cleaned only after upload', async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chatgpt-controller-image-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const stateStore = new StateStore(directory, 'guild-1');
  const channel = fakeTextChannel('chat-channel-1', 'bot-user');
  stateStore.setChatgptConversation(CONVERSATION_ID, {
    channelId: channel.id,
    name: 'Image chat',
    conversationUrl: `https://chatgpt.com/c/${CONVERSATION_ID}`,
    responsePerformance: 'fastest',
  });
  const client = new EventEmitter();
  client.user = { id: 'bot-user' };
  client.channels = { fetch: async () => channel };
  let materializedRoot = null;
  const service = {
    activeCount: 0,
    async send(options) {
      materializedRoot = options.returnedFileOutputRoot;
      fs.mkdirSync(materializedRoot, { recursive: true });
      const imagePath = path.join(materializedRoot, 'preview.png');
      const content = Buffer.from('image-bytes');
      fs.writeFileSync(imagePath, content);
      return {
        requestMessageId: 'request-image-1',
        assistantMessageId: 'assistant-image-1',
        assistantText: 'image answer',
        assistantAttachments: [{ name: 'preview.png', mimeType: 'image/png', size: content.length }],
        returnedFileMaterialization: returnedFileMaterialization(materializedRoot, [{
          descriptor: { name: 'preview.png', mimeType: 'image/png', size: content.length },
          materialization: {
            status: 'READY',
            code: null,
            path: imagePath,
            sizeBytes: content.length,
            sha256: createHash('sha256').update(content).digest('hex'),
            contentType: 'image/png',
          },
        }]),
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
      fileShareChunkBytes: 7_500_000,
      fileShareMaxBytes: 512_000_000,
    },
    logDir: directory,
    incomingAttachmentStore: { store: async () => [] },
  });
  controller.attach();
  client.emit('messageCreate', fakeDiscordMessage('discord-message-1', channel));
  const record = await waitForRecord(stateStore, 'completed');
  assert.equal(record.returnedFileReadyCount, 1);
  assert.equal(record.returnedFileUnavailableCount, 0);
  assert.equal(record.returnedFilePostsComplete, true);
  assert.equal(record.returnedFileCleanup, 'removed');
  assert.equal(fs.existsSync(materializedRoot), false);
  assert.equal(record.responseMessageIds.length, 2);
  const imageMessage = channel._messages.get(record.responseMessageIds[1]);
  assert.equal(imageMessage.content.startsWith('**ChatGPT image**'), true);
  assert.equal(imageMessage.files[0].name, 'preview.png');
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
