import test from 'node:test';
import assert from 'node:assert/strict';
import {
  coalesceCodexNotification,
  isControllerCodexNotification,
  isHighVolumeCodexNotification,
} from '../src/codex-notification-buffer.mjs';

function delta(method, value, overrides = {}) {
  return {
    eventSequence: overrides.eventSequence ?? 1,
    message: {
      method,
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'item-1',
        delta: value,
        ...overrides.params,
      },
    },
  };
}

test('coalesces only adjacent compatible content deltas in exact order', () => {
  const first = delta('item/agentMessage/delta', 'abc', { eventSequence: 4 });
  const second = delta('item/agentMessage/delta', 'def', { eventSequence: 5 });
  const merged = coalesceCodexNotification(first, second);

  assert.equal(merged.message.params.delta, 'abcdef');
  assert.equal(merged.eventSequence, 5);
  assert.equal(coalesceCodexNotification(
    merged,
    delta('item/agentMessage/delta', 'other', {
      eventSequence: 6,
      params: { itemId: 'item-2' },
    }),
  ), null);
  assert.equal(coalesceCodexNotification(
    first,
    delta('item/completed', '', { eventSequence: 5 }),
  ), null);
});

test('retains controller structural notifications and drops unused output floods', () => {
  assert.equal(isControllerCodexNotification({ method: 'turn/completed' }), true);
  assert.equal(isControllerCodexNotification({ method: 'item/agentMessage/delta' }), true);
  assert.equal(isControllerCodexNotification({ method: 'item/commandExecution/outputDelta' }), false);
  assert.equal(isControllerCodexNotification({ method: 'turn/diff/updated' }), false);
});

test('identifies content and command output deltas as high-volume log events', () => {
  assert.equal(isHighVolumeCodexNotification({ method: 'item/agentMessage/delta' }), true);
  assert.equal(isHighVolumeCodexNotification({ method: 'item/commandExecution/outputDelta' }), true);
  assert.equal(isHighVolumeCodexNotification({ method: 'turn/completed' }), false);
});
