import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { recoverDiscordMessages } from '../src/discord-message-recovery.mjs';
import { DiscordController } from '../src/discord-controller.mjs';
import { DeliveryOutbox } from '../src/delivery-outbox.mjs';

function fixture(context) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-message-recovery-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const outbox = new DeliveryOutbox(path.join(directory, 'outbox'));
  outbox.initializeRecoveryCursor('100');
  return { directory, outbox };
}

for (const event of ['shardReady', 'shardResume']) {
  test(`${event} catches up persisted channel cursors without replaying older messages`, async (context) => {
    const { directory, outbox } = fixture(context);
    const client = new EventEmitter();
    const codex = new EventEmitter();
    codex.connected = true;
    const message = { id: '101', author: { bot: true }, content: 'already visible bot card' };
    client.channels = { fetch: async () => ({ messages: {
      fetch: async ({ after }) => new Map(BigInt(after) < 101n ? [['101', message]] : []),
    } }) };
    const controller = new DiscordController({
      client, codex, deliveryOutbox: outbox, logDir: directory, config: {},
      stateStore: { snapshot: () => ({}), bindings: () => [
        { threadId: 'local-task', channelId: 'local-channel' },
      ] },
    });
    controller.attach();
    context.after(() => controller.stop());
    client.emit(event, 0);
    await controller.discordRecoveryPromise;
    assert.equal(outbox.channelRecoveryCursor('local-channel'), '101');
    client.emit(event, 0);
    await controller.discordRecoveryPromise;
    assert.equal(outbox.channelRecoveryCursor('local-channel'), '101');
    assert.deepEqual(outbox.list(), []);
  });
}

test('recovery queues only eligible newer inputs in message order and persists the catch-up cut', async (context) => {
  const { outbox } = fixture(context);
  const messages = [
    { id: '104', eligible: true, text: 'verify' },
    { id: '103', eligible: false, text: 'bot or unauthorized input' },
    { id: '102', eligible: true, text: 'implement' },
    { id: '100', eligible: true, text: 'already processed' },
  ];
  const queued = [];
  const options = {
    bindings: [{ channelId: 'channel' }], outbox, reason: 'test-reconnect',
    fetchChannel: async () => ({ messages: { fetch: async () => new Map(messages.map(m => [m.id, m])) } }),
    shouldRecover: m => m.eligible,
    enqueueMessage: async m => {
      queued.push(m.text);
      outbox.advanceChannelRecoveryCursor('channel', m.id);
    },
    isStopping: () => false,
  };
  await recoverDiscordMessages(options);
  assert.deepEqual(queued, ['implement', 'verify']);
  assert.equal(outbox.channelRecoveryCursor('channel'), '104');
  await recoverDiscordMessages(options);
  assert.deepEqual(queued, ['implement', 'verify']);
});

test('an input not durably admitted never advances the cursor or skips the next input', async (context) => {
  const { outbox } = fixture(context);
  const messages = [{ id: '101' }, { id: '102' }];
  const queued = [];
  await assert.rejects(recoverDiscordMessages({
    bindings: [{ channelId: 'channel' }], outbox, reason: 'reconnect',
    fetchChannel: async () => ({ messages: { fetch: async () => new Map(messages.map(m => [m.id, m])) } }),
    shouldRecover: () => true,
    enqueueMessage: async m => { queued.push(m.id); },
    isStopping: () => false,
  }), /did not advance its cursor: 101/);
  assert.deepEqual(queued, ['101']);
  assert.equal(outbox.channelRecoveryCursor('channel'), '100');
});

test('a shutdown during catch-up leaves remaining messages available for the next process', async (context) => {
  const { outbox } = fixture(context);
  let stopping = false;
  const queued = [];
  const messages = [{ id: '101' }, { id: '102' }];
  await recoverDiscordMessages({
    bindings: [{ channelId: 'channel' }], outbox, reason: 'reconnect',
    fetchChannel: async () => ({ messages: { fetch: async () => new Map(messages.map(m => [m.id, m])) } }),
    shouldRecover: () => true,
    enqueueMessage: async m => {
      queued.push(m.id);
      outbox.advanceChannelRecoveryCursor('channel', m.id);
      stopping = true;
    },
    isStopping: () => stopping,
  });
  assert.deepEqual(queued, ['101']);
  assert.equal(outbox.channelRecoveryCursor('channel'), '101');
});
