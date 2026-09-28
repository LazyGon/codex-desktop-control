import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DiscordController } from '../src/discord-controller.mjs';
import { StateStore } from '../src/state-store.mjs';
import { CodexService } from '../src/codex-service.mjs';
import { interactionOwned, localChannelOwned, taskIdFromTopic } from '../src/task-routing.mjs';

function fixture(context, instanceId, threadId) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-routing-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const client = new EventEmitter();
  const codex = new EventEmitter();
  const reads = [];
  codex.hasLocalThread = async (id) => { reads.push(id); return id === threadId; };
  const stateStore = new StateStore(directory, 'guild');
  stateStore.setInfrastructure({ controlChannelId: `control-${instanceId}` });
  stateStore.setProjectCategory(instanceId, { categoryIds: [`category-${instanceId}`], path: 'C:\\project' });
  stateStore.setBinding(threadId, { channelId: `task-${instanceId}`, watchLevel: 'normal' });
  const config = { multiPcEnabled: true, instanceId, guildId: 'guild', authorizedUserIds: ['user'] };
  const controller = new DiscordController({ client, codex, stateStore, config, logDir: directory });
  controller.attach();
  context.after(() => controller.stop());
  return { client, codex, reads, stateStore, config, controller };
}

function interaction(channelId, task = null) {
  return {
    id: 'request-1', guildId: 'guild', channelId, commandName: 'codex', user: { id: 'user' },
    options: { getSubcommand: () => 'watch', getSubcommandGroup: () => null,
      getString: (name) => name === 'task' ? task : name === 'level' ? 'quiet' : null },
    isAutocomplete: () => false, isChatInputCommand: () => true, isStringSelectMenu: () => false,
    isButton: () => false, isModalSubmit: () => false, isRepliable: () => true,
    replies: [], reply: async function reply(payload) { this.replies.push(payload); this.replied = true; },
  };
}

test('two independent PCs see the same command but only the task owner ACKs and executes', async (context) => {
  const a = fixture(context, 'A', 'thread-A');
  const b = fixture(context, 'B', 'thread-B');
  const eventA = interaction('task-A');
  const eventB = interaction('task-A');
  a.client.emit('interactionCreate', eventA);
  b.client.emit('interactionCreate', eventB);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(eventA.replies.length, 1);
  assert.equal(eventB.replies.length, 0);
  assert.equal(a.stateStore.binding('thread-A').watchLevel, 'quiet');
  assert.equal(b.stateStore.binding('thread-B').watchLevel, 'normal');
});

test('explicit task target routes to its PC even from the other PC control channel', async (context) => {
  const a = fixture(context, 'A', 'thread-A');
  const b = fixture(context, 'B', 'thread-B');
  const eventA = interaction('control-A', 'thread-B');
  const eventB = interaction('control-A', 'thread-B');
  a.client.emit('interactionCreate', eventA);
  b.client.emit('interactionCreate', eventB);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(eventA.replies.length, 0);
  assert.equal(eventB.replies.length, 1);
});

test('merged task list ACKs once and preserves PC-qualified selections and explicit unavailable peers', async (context) => {
  const a = fixture(context, 'A', 'thread-A');
  const b = fixture(context, 'B', 'thread-B');
  const collections = [];
  for (const host of [a, b]) host.controller.taskListFederation = { collect: async (request) => {
    collections.push([host.config.instanceId, request]);
    return { threads: [{ id: 'thread-B', instanceId: 'B', name: 'Remote', status: { type: 'idle' }, cwd: 'C:\\remote' }],
      sources: [{ instanceId: 'A', available: true }, { instanceId: 'B', available: true }, { instanceId: 'C', available: false }] };
  } };
  const events = [a, b].map(() => {
    const event = interaction('control-A');
    event.options.getSubcommand = () => 'tasks';
    event.deferReply = async () => { event.deferred = true; };
    event.editReply = async (payload) => { event.result = payload; };
    return event;
  });
  a.client.emit('interactionCreate', events[0]);
  b.client.emit('interactionCreate', events[1]);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(collections, [['A', { requestId: 'request-1', userId: 'user', search: null }]]);
  assert.equal(events[0].deferred, true);
  assert.equal(events[1].deferred, undefined);
  assert.match(events[0].result.content, /未取得PC.*C/);
  assert.equal(events[0].result.components[0].toJSON().components[0].options[0].value, 'B:thread-B');
  assert.match(events[0].result.files[0].attachment.toString('utf8'), /Task: thread-B/);
});

test('taskless events and autocomplete route by locally registered category IDs, not guild-wide existence', async (context) => {
  const a = fixture(context, 'A', 'thread-A');
  const b = fixture(context, 'B', 'thread-B');
  const event = interaction('unbound');
  event.channel = { parentId: 'category-A' };
  event.isAutocomplete = () => true;
  event.options.getFocused = () => ({ name: 'task', value: 'a partial search' });
  assert.equal(await interactionOwned({ ...a, interaction: event }), true);
  assert.equal(await interactionOwned({ ...b, interaction: event }), false);
  assert.deepEqual(a.reads, []);
  assert.equal(localChannelOwned(a.stateStore, 'unbound', { parentId: 'category-B' }), false);
  assert.equal(taskIdFromTopic({ topic: 'Project: abc\nCodex task: thread-B\nState: idle' }), 'thread-B');
});

test('PC identity in merged selector prevents another PC from claiming a duplicated task UUID', async (context) => {
  const a = fixture(context, 'A', 'copied-thread');
  const b = fixture(context, 'B', 'copied-thread');
  const event = { ...interaction('control-A'), commandName: undefined, customId: 'cx:open', values: ['B:copied-thread'] };
  assert.equal(await interactionOwned({ ...a, interaction: event }), false);
  assert.equal(await interactionOwned({ ...b, interaction: event }), true);
});

test('unknown opaque modal/session never steals the owner reply, even in a local control channel', async (context) => {
  const a = fixture(context, 'A', 'thread-A');
  const event = { ...interaction('control-A'), commandName: undefined, customId: 'cx:compose:other-pc-session' };
  assert.equal(await interactionOwned({ ...a, interaction: event }), false);
  assert.equal(await interactionOwned({ ...a, interaction: event,
    pendingActions: new Map([['other-pc-session', { threadId: 'thread-A' }]]) }), true);
});

test('indeterminate membership and wrong guild are silent without ACK or task mutation', async (context) => {
  const a = fixture(context, 'A', 'thread-A');
  a.codex.hasLocalThread = async () => { throw new Error('disconnected'); };
  const event = interaction('task-A');
  a.client.emit('interactionCreate', event);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(event.replies, []);
  const foreignGuild = { ...interaction('task-A'), guildId: 'other' };
  assert.equal(await interactionOwned({ ...a, interaction: foreignGuild }), false);
});

test('foreign topic in an unbound locally managed category is not replaced by a new task', async (context) => {
  const a = fixture(context, 'A', 'thread-A');
  a.config.plainMessageInputEnabled = true;
  const message = { guildId: 'guild', channelId: 'unbound', author: { id: 'user', bot: false },
    channel: { id: 'unbound', type: 0, parentId: 'category-A', topic: 'Codex task: foreign-thread' } };
  a.codex.startThread = async () => { assert.fail('Must not create a duplicate/replacement task'); };
  a.client.emit('messageCreate', message);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(a.stateStore.bindingByChannel('unbound'), null);
});

test('local membership uses only bounded thread/read without resume or turn history', async () => {
  const service = new CodexService({ config: {}, stateStore: {}, discoverEndpoint: () => ({}), logDir: os.tmpdir() });
  const calls = [];
  service.client = { connected: true, call: async (...args) => { calls.push(args); return { thread: { id: 'thread' } }; } };
  assert.equal(await service.hasLocalThread('thread'), true);
  assert.deepEqual(calls, [['thread/read', { threadId: 'thread', includeTurns: false }, 1200]]);
  service.client.call = async () => { throw new Error('missing'); };
  assert.equal(await service.hasLocalThread('foreign'), false);
  service.client.connected = false;
  assert.equal(await service.hasLocalThread('thread'), false);
});
