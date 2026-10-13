import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { DiscordController } from '../src/discord-controller.mjs';
import { StateStore } from '../src/state-store.mjs';

async function fixture(context) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-live-activity-'));
  const stateStore = new StateStore(directory, 'guild');
  stateStore.setBinding('task', {
    channelId: 'channel', name: 'Activity', watchLevel: 'normal',
    snapshotInitialized: true, transcriptVersion: 11, completionReportsEnabled: false,
  });
  const client = new EventEmitter(), codex = new EventEmitter(), messages = new Map();
  client.user = { id: 'bot', bot: true };
  let nextId = 1;
  const channel = {
    id: 'channel', name: '🟢-activity', topic: 'Turn: running',
    messages: { fetch: async value => typeof value === 'string' ? messages.get(value)
      : Object.assign(new Map(messages), { last: () => [...messages.values()].at(-1) }) },
    edit: async payload => Object.assign(channel, payload),
    send: async payload => {
      const message = {
        id: `message-${nextId++}`, author: client.user, content: '', embeds: [], components: [], attachments: new Map(),
        edit: async next => {
          if (channel.beforeEdit) await channel.beforeEdit(next);
          if (next.embeds) message.embeds = next.embeds.map(embed => embed.toJSON?.() ?? embed);
          if (next.components) message.components = next.components;
          message.content = next.content ?? message.content;
          return message;
        },
        delete: async () => messages.delete(message.id),
      };
      await message.edit(payload);
      messages.set(message.id, message);
      return message;
    },
  };
  client.channels = { fetch: async () => channel };
  const controller = new DiscordController({ client, codex, stateStore, logDir: directory,
    config: { liveUpdateIntervalMs: 2, elapsedUpdateIntervalMs: 60_000 } });
  controller.attach();
  context.after(async () => {
    await controller.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const notify = async (method, params) => {
    codex.emit('notification', { method, params: { threadId: 'task', turnId: 'turn', ...params } });
    await new Promise(resolve => setImmediate(resolve));
    await controller.notificationQueues.get('task');
  };
  const view = () => controller.turnViews.get('task:turn');
  const flush = async () => {
    while (view()?.timer || view()?.renderPromise) {
      if (view().renderPromise) await view().renderPromise;
      else await delay(5);
    }
  };
  const activity = () => messages.get(view().messageId).embeds[0].fields
    .find(field => field.name === '進行状況').value;
  await notify('turn/started', { turn: { id: 'turn', status: 'inProgress', items: [] } });
  return { channel, notify, view, flush, activity };
}

test('live public deltas and commands update the same five-row field before completion', { timeout: 5000 }, async context => {
  const f = await fixture(context);
  const messageId = f.view().messageId;
  assert.equal(f.activity().split('\n').slice(1, -1).length, 5);
  await f.notify('item/reasoning/summaryTextDelta', { itemId: 'summary', summaryIndex: 0, delta: 'Checking the layout' });
  await f.flush();
  assert.match(f.activity(), /Checking the layout/);
  await f.notify('item/reasoning/textDelta', { itemId: 'raw', delta: 'PRIVATE_REASONING' });
  await f.notify('item/started', { item: { id: 'raw', type: 'reasoning', summary: [], content: ['PRIVATE_REASONING'] } });
  await f.notify('item/started', { item: { id: 'command-1', type: 'commandExecution', command: 'npm test', status: 'inProgress' } });
  await f.notify('item/started', { item: { id: 'command-2', type: 'commandExecution', command: 'git diff', status: 'inProgress' } });
  await f.flush();
  assert.equal(f.view().messageId, messageId);
  assert.match(f.activity(), /npm test/);
  assert.match(f.activity(), /git diff/);
  assert.equal(f.activity().includes('PRIVATE_REASONING'), false);
  assert.equal(f.activity().split('\n').slice(1, -1).length, 5);
  await f.notify('item/started', { item: { id: 'long-command', type: 'commandExecution',
    command: 'node test.mjs ' + '日本語引数 '.repeat(30), status: 'inProgress' } });
  await f.flush();
  const rows = f.activity().split('\n').slice(1, -1);
  assert.equal(rows.length, 5);
  assert.ok(rows.every(row => row.includes('日本語') || row.includes('引数')));
});

test('a delta arriving during a Discord edit renders again without waiting for the elapsed timer', { timeout: 5000 }, async context => {
  const f = await fixture(context);
  let entered, release;
  const editing = new Promise(resolve => { entered = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  context.after(() => release());
  f.channel.beforeEdit = async () => {
    f.channel.beforeEdit = null;
    entered();
    await blocked;
  };
  await f.notify('item/reasoning/summaryTextDelta', { itemId: 'summary', summaryIndex: 0, delta: 'First update' });
  await editing;
  await f.notify('item/reasoning/summaryTextDelta', { itemId: 'summary', summaryIndex: 0, delta: '\nLatest update' });
  assert.equal(f.view().renderRequested, true);
  release();
  await f.flush();
  assert.match(f.activity(), /Latest update/);
  assert.equal(f.activity().split('\n').slice(1, -1).length, 5);
});
