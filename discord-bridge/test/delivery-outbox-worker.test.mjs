import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DeliveryOutbox } from '../src/delivery-outbox.mjs';
import { DeliveryOutboxWorker } from '../src/delivery-outbox-worker.mjs';

test('a new input is picked up during dispatch without waiting for uncertain-history reconciliation', { timeout: 5000 }, async (context) => {
  const temp = path.resolve(os.tmpdir());
  const directory = fs.mkdtempSync(path.join(temp, 'codex-delivery-worker-'));
  context.after(() => {
    assert.equal(path.dirname(directory), temp);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const outbox = new DeliveryOutbox(directory);
  const enqueue = (requestId) => outbox.enqueue({
    requestId, threadId: 'thread', prompt: requestId, source: { channelId: 'channel' },
  });
  enqueue('uncertain');
  const attempt = outbox.beginAttempt('uncertain', { mode: 'send' });
  outbox.markUncertain('uncertain', { attemptId: attempt.attempt.attemptId, error: 'transport closed' });

  const history = Promise.withResolvers();
  const firstStarted = Promise.withResolvers();
  const firstFinished = Promise.withResolvers();
  const sent = [];
  let reconciling = false;
  const worker = new DeliveryOutboxWorker({
    outbox,
    codex: {
      connected: true,
      prepareDelivery: async () => ({ mode: 'send' }),
      executePreparedDelivery: async (_thread, _prompt, _attachments, requestId) => {
        sent.push(requestId);
        if (requestId === 'first') {
          firstStarted.resolve();
          await firstFinished.promise;
        }
        return { mode: 'send', turnId: `turn-${requestId}` };
      },
      findDeliveryReceipt: async () => {
        reconciling = true;
        return history.promise;
      },
    },
    staleReason: () => null,
    present: async (entry) => {
      const claimed = outbox.beginCallback(entry.requestId);
      outbox.completeCallback(entry.requestId, { attemptId: claimed.callback.attemptId, outcome: 'displayed' });
    },
    isStopping: () => false,
    log: () => {},
  });

  enqueue('first');
  const initial = worker.request('message');
  try {
    await firstStarted.promise;
    assert.equal(reconciling, true);
    enqueue('second');
    void worker.request('message');
    firstFinished.resolve();
    await initial;
    assert.deepEqual(sent, ['first', 'second']);
    assert.equal(outbox.get('second').receipt.turnId, 'turn-second');
    assert.equal(outbox.get('second').callback.state, 'pending');
    assert.equal(outbox.get('uncertain').state, 'uncertain');
  } finally {
    firstFinished.resolve();
    history.resolve(null);
    await Promise.all(worker.pendingWork().map(([, promise]) => promise));
  }
  assert.equal(outbox.get('second').callback.state, 'delivered');
});
