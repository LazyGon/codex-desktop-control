import test from 'node:test';
import assert from 'node:assert/strict';
import { LatestUpdateQueue } from '../src/latest-update-queue.mjs';

test('latest update queue does not block callers and coalesces a pending key', async () => {
  let releaseFirst;
  const firstBlocked = new Promise((resolve) => { releaseFirst = resolve; });
  const applied = [];
  const queue = new LatestUpdateQueue({
    equals: (left, right) => left.value === right.value,
    apply: async (update) => {
      applied.push(update.value);
      if (update.value === 'first') await firstBlocked;
    },
  });

  assert.equal(queue.schedule('channel-1', { value: 'first' }), true);
  assert.equal(queue.schedule('channel-1', { value: 'second' }), false);
  assert.equal(queue.schedule('channel-1', { value: 'latest' }), false);
  assert.deepEqual(applied, ['first']);

  releaseFirst();
  for (let attempt = 0; attempt < 100 && applied.length < 2; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.deepEqual(applied, ['first', 'latest']);
});

test('latest update queue releases a failed key for a later retry', async () => {
  const errors = [];
  let attempts = 0;
  const queue = new LatestUpdateQueue({
    apply: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('rate limited');
    },
    onError: (error) => errors.push(error.message),
  });

  assert.equal(queue.schedule('channel-1', 'status'), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(queue.schedule('channel-1', 'status'), true);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(attempts, 2);
  assert.deepEqual(errors, ['rate limited']);
});
