import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { DiscordController } from '../src/discord-controller.mjs';
import { StateStore } from '../src/state-store.mjs';
import { taskPanelPayload } from '../src/discord-panels.mjs';

async function fixture(context) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-task-status-'));
  const stateStore = new StateStore(directory, 'guild');
  stateStore.setBinding('task', {
    channelId: 'channel', name: 'Test', taskStatus: 'idle', watchLevel: 'quiet',
    sessionPath: path.join(directory, 'missing-session.jsonl'),
    snapshotInitialized: true, transcriptVersion: 11, completionReportsEnabled: false,
  });
  const messages = new Map();
  let nextMessageId = 1;
  const client = new EventEmitter();
  client.user = { id: 'bot' };
  const channel = {
    id: 'channel', name: '⚫-test', topic: 'Codex task: task\nTurn: stopped',
    messages: { fetch: async value => typeof value === 'string' ? messages.get(value)
      : Object.assign(new Map(messages), { last: () => [...messages.values()].at(-1) }) },
    edit: async ({ name, topic }) => { channel.name = name; channel.topic = topic; return channel; },
    send: async payload => {
      const message = {
        id: `message-${nextMessageId++}`, author: client.user, content: payload.content ?? '',
        embeds: [], components: [], attachments: new Map(),
        edit: async next => {
          message.content = next.content ?? message.content;
          if (next.embeds) message.embeds = next.embeds.map(embed => embed.toJSON?.() ?? embed);
          if (next.components) message.components = next.components.map(component => component.toJSON?.() ?? component);
          return message;
        },
        delete: async () => messages.delete(message.id),
      };
      await message.edit(payload);
      messages.set(message.id, message);
      return message;
    },
  };
  const panel = await channel.send(taskPanelPayload({
    thread: { id: 'task', name: 'Test', status: { type: 'idle' } }, binding: stateStore.binding('task'),
  }));
  stateStore.setBinding('task', { controlPanelMessageId: panel.id });
  client.channels = { fetch: async () => channel };
  const codex = new EventEmitter();
  const controller = new DiscordController({
    client, codex, stateStore, logDir: directory,
    config: { liveUpdateIntervalMs: 5, elapsedUpdateIntervalMs: 60_000 },
  });
  controller.attach();
  context.after(async () => {
    await controller.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const notify = async (method, params) => {
    codex.emit('notification', { method, params: { threadId: 'task', ...params } });
    await new Promise(resolve => setImmediate(resolve));
    await controller.notificationQueues.get('task');
    await new Promise(resolve => setImmediate(resolve));
  };
  const complete = async (id, status) => {
    const message = await channel.send({ embeds: [{ title: `Codex turn ${status}` }] });
    stateStore.setTurnRecord('task', id, {
      status, finalizedAt: new Date().toISOString(), finalMessageIds: [message.id], finalText: status,
    });
    await notify('turn/completed', { turn: { id, status, items: [] } });
  };
  return { directory, stateStore, messages, channel, notify, complete };
}

test('systemError notification turns the parent channel and card red and survives idle and reload', async context => {
  const f = await fixture(context);
  await f.notify('thread/status/changed', { status: { type: 'systemError' } });
  assert.equal(f.channel.name, '🔴-test');
  assert.equal(f.stateStore.binding('task').taskStatus, 'systemError');
  const panel = f.messages.get(f.stateStore.binding('task').controlPanelMessageId);
  assert.match(JSON.stringify(panel.embeds), /systemError/);
  await f.notify('thread/status/changed', { status: { type: 'idle' } });
  assert.equal(f.channel.name, '🔴-test');
  assert.equal(new StateStore(f.directory, 'guild').binding('task').taskStatus, 'systemError');
  await f.notify('thread/status/changed', { status: { type: 'active', activeFlags: ['waitingOnUserInput'] } });
  assert.equal(f.channel.name, '🟢-test');
  assert.match(JSON.stringify(f.messages.get(f.stateStore.binding('task').controlPanelMessageId).embeds), /waitingOnUserInput/);
  await f.notify('thread/status/changed', { status: { type: 'idle' } });
  assert.equal(f.channel.name, '⚫-test');
});

test('a newly failed turn creates its final card and does not reset the task panel to idle', async context => {
  const f = await fixture(context);
  await f.notify('turn/completed', { turn: {
    id: 'new-failure', status: 'failed', error: { message: 'System failure' },
    items: [{ id: 'final', type: 'agentMessage', text: 'System failure', phase: 'final_answer' }],
  } });
  assert.equal(f.channel.name, '🔴-test');
  assert.equal(f.stateStore.binding('task').taskStatus, 'systemError');
  assert.ok(f.stateStore.turnRecord('task', 'new-failure').finalMessageIds?.length);
  assert.match(JSON.stringify(f.messages.get(f.stateStore.binding('task').controlPanelMessageId).embeds), /systemError/);
});

test('failed completion stays red through panel repost and a new turn clears it', async context => {
  const f = await fixture(context);
  await f.complete('failed-turn', 'failed');
  assert.equal(f.channel.name, '🔴-test');
  assert.equal(f.stateStore.binding('task').taskStatus, 'systemError');
  assert.match(JSON.stringify(f.messages.get(f.stateStore.binding('task').controlPanelMessageId).embeds), /systemError/);
  await f.notify('thread/status/changed', { status: { type: 'idle' } });
  assert.equal(f.channel.name, '🔴-test');
  await f.notify('turn/started', { turn: { id: 'next-turn', status: 'inProgress', items: [] } });
  assert.equal(f.channel.name, '🟢-test');
  await f.complete('next-turn', 'completed');
  assert.equal(f.channel.name, '⚫-test');
});

test('retrying errors and warnings do not mark an active task red; interruption is black', async context => {
  const f = await fixture(context);
  await f.notify('thread/status/changed', { status: { type: 'active' } });
  await f.notify('error', { message: 'Temporary connection failure', willRetry: true });
  await f.notify('warning', { message: 'A warning' });
  assert.equal(f.channel.name, '🟢-test');
  assert.equal(f.stateStore.binding('task').taskStatus, 'active');
  await f.complete('interrupted-turn', 'interrupted');
  assert.equal(f.channel.name, '⚫-test');
});

test('late failed completion of an older turn does not override the newer running turn', async context => {
  const f = await fixture(context);
  await f.notify('turn/started', { turn: { id: 'new-turn', status: 'inProgress', items: [] } });
  await f.complete('old-turn', 'failed');
  assert.equal(f.stateStore.binding('task').taskStatus, 'active');
  assert.equal(f.channel.name, '🟢-test');
});
