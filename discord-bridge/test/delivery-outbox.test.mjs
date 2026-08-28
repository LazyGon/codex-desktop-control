import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  DeliveryOutbox,
  DeliveryOutboxLockedError,
  discordSnowflakeAt,
} from '../src/delivery-outbox.mjs';

function fixture(context, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-delivery-outbox-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let sequence = 0;
  return new DeliveryOutbox(directory, {
    ownerPid: 1234,
    clock: () => `2026-08-28T00:00:0${sequence++}.000Z`,
    uuid: () => `attempt-${sequence++}`,
    isProcessAlive: options.isProcessAlive ?? ((pid) => pid === 1234),
  });
}

function request(overrides = {}) {
  return {
    requestId: 'discord-message:guild:channel:message',
    threadId: 'thread-1',
    prompt: 'continue the task',
    attachments: [],
    source: {
      kind: 'discord-message',
      guildId: 'guild',
      channelId: 'channel',
      messageId: 'message',
      userId: 'user',
      userTag: 'user#0001',
    },
    ...overrides,
  };
}

test('DeliveryOutbox only contains explicitly enqueued post-deployment requests', (context) => {
  const outbox = fixture(context);
  outbox.ensureDirectory();
  assert.deepEqual(outbox.list(), []);

  const first = outbox.enqueue(request());
  const duplicate = outbox.enqueue(request());
  assert.equal(first.state, 'queued');
  assert.deepEqual(duplicate, first);
  assert.equal(outbox.list().length, 1);
  assert.throws(
    () => outbox.enqueue(request({ prompt: 'different payload' })),
    /payload mismatch/,
  );
});

test('DeliveryOutbox binds acceptance and callback receipts to exact attempt IDs', (context) => {
  const outbox = fixture(context);
  outbox.enqueue(request());
  const attempting = outbox.beginAttempt(request().requestId, {
    mode: 'steer',
    expectedTurnId: 'turn-active',
  });
  const attemptId = attempting.attempt.attemptId;
  assert.equal(attempting.state, 'attempting');
  assert.throws(() => outbox.accept(request().requestId, {
    attemptId: 'wrong-attempt',
    mode: 'steer',
    turnId: 'turn-active',
  }), /receipt mismatch/);

  const accepted = outbox.accept(request().requestId, {
    attemptId,
    mode: 'steer',
    turnId: 'turn-active',
  });
  assert.deepEqual(accepted.receipt, {
    requestId: request().requestId,
    attemptId,
    mode: 'steer',
    turnId: 'turn-active',
    acceptedAt: accepted.receipt.acceptedAt,
    reconciled: false,
  });

  const delivering = outbox.beginCallback(request().requestId);
  const callbackAttemptId = delivering.callback.attemptId;
  assert.throws(() => outbox.completeCallback(request().requestId, {
    attemptId: 'wrong-callback',
    outcome: 'reaction:✅',
  }), /callback receipt mismatch/);
  const delivered = outbox.completeCallback(request().requestId, {
    attemptId: callbackAttemptId,
    outcome: 'reaction:✅',
  });
  assert.equal(delivered.callback.state, 'delivered');
  assert.throws(() => outbox.beginCallback(request().requestId), /not pending/);
});

test('DeliveryOutbox fails closed for uncertain launch, stale ownership, and overlap', (context) => {
  const alive = new Set([1234, 4321]);
  const outbox = fixture(context, { isProcessAlive: (pid) => alive.has(pid) });
  outbox.enqueue(request());
  const attempting = outbox.beginAttempt(request().requestId, { mode: 'send' });
  const uncertain = outbox.markUncertain(request().requestId, {
    attemptId: attempting.attempt.attemptId,
    error: new Error('socket closed'),
  });
  assert.equal(uncertain.state, 'uncertain');
  assert.throws(
    () => outbox.beginAttempt(request().requestId, { mode: 'send' }),
    /not queued/,
  );

  const second = request({ requestId: 'discord-message:guild:channel:second' });
  outbox.enqueue(second);
  const secondAttempt = outbox.beginAttempt(second.requestId, { mode: 'send' });
  alive.delete(1234);
  const recovered = outbox.recoverStaleOwnership();
  assert.ok(recovered.some((entry) => entry.requestId === second.requestId && entry.kind === 'delivery'));
  assert.equal(outbox.get(second.requestId).state, 'uncertain');
  assert.equal(outbox.get(second.requestId).attempt.attemptId, secondAttempt.attempt.attemptId);

  alive.add(4321);
  const lockPath = outbox.lockPath(second.requestId);
  fs.writeFileSync(lockPath, `${JSON.stringify({ ownerPid: 4321 })}\n`, 'utf8');
  assert.throws(() => outbox.acceptReconciled(second.requestId, { turnId: 'turn-2' }), DeliveryOutboxLockedError);
  fs.unlinkSync(lockPath);
  fs.writeFileSync(lockPath, '', 'utf8');
  assert.throws(() => outbox.acceptReconciled(second.requestId, { turnId: 'turn-2' }), DeliveryOutboxLockedError);
});

test('DeliveryOutbox reconciles an uncertain request without replacing its attempt', (context) => {
  const outbox = fixture(context);
  outbox.enqueue(request());
  const attempting = outbox.beginAttempt(request().requestId, {
    mode: 'send',
    expectedTurnId: null,
  });
  outbox.markUncertain(request().requestId, {
    attemptId: attempting.attempt.attemptId,
    error: 'timeout',
  });
  const accepted = outbox.acceptReconciled(request().requestId, {
    turnId: 'turn-reconciled',
  });
  assert.equal(accepted.state, 'accepted');
  assert.equal(accepted.receipt.attemptId, attempting.attempt.attemptId);
  assert.equal(accepted.receipt.reconciled, true);
  assert.equal(accepted.receipt.turnId, 'turn-reconciled');
});

test('DeliveryOutbox never overwrites or skips a corrupt entry', (context) => {
  const outbox = fixture(context);
  const corrupt = request({ requestId: 'discord-message:guild:channel:corrupt' });
  outbox.ensureDirectory();
  fs.writeFileSync(outbox.filePath(corrupt.requestId), '{not-json', 'utf8');
  assert.throws(() => outbox.get(corrupt.requestId), /missing or invalid/);
  assert.throws(() => outbox.list(), /missing or invalid/);
  assert.throws(() => outbox.enqueue(corrupt), /cannot be parsed/);
  assert.equal(fs.readFileSync(outbox.filePath(corrupt.requestId), 'utf8'), '{not-json');
});

test('Discord recovery cursor establishes one cutover and advances per channel monotonically', (context) => {
  const outbox = fixture(context);
  const cutover = discordSnowflakeAt(Date.UTC(2026, 7, 28, 0, 0, 0));
  const later = (BigInt(cutover) + 100n).toString();
  const earlier = (BigInt(cutover) - 1n).toString();
  const initialized = outbox.initializeRecoveryCursor(cutover);
  assert.equal(initialized.cutoverMessageId, cutover);
  assert.deepEqual(initialized.channels, {});
  assert.equal(outbox.channelRecoveryCursor('channel-1'), cutover);

  outbox.advanceChannelRecoveryCursor('channel-1', later);
  outbox.advanceChannelRecoveryCursor('channel-1', earlier);
  assert.equal(outbox.channelRecoveryCursor('channel-1'), later);
  assert.equal(outbox.initializeRecoveryCursor(discordSnowflakeAt()).cutoverMessageId, cutover);
  assert.throws(() => outbox.advanceChannelRecoveryCursor('channel-1', 'not-a-snowflake'), /snowflake/);
});
