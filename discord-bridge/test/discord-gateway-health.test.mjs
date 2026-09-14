import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_GATEWAY_RECYCLE_AFTER_MS,
  DiscordGatewayHealth,
} from '../src/discord-gateway-health.mjs';

test('one unresolved transient Gateway error requests one recycle after five minutes', () => {
  const health = new DiscordGatewayHealth();
  health.markReady({ at: 0, shardId: 0 });
  const first = health.recordError(new Error('Opening handshake has timed out'), {
    at: 1_000,
    shardId: 0,
  });
  assert.equal(first.shouldRecycle, false);
  assert.equal(health.claimRecycleIfDue({ at: 300_999 }).shouldRecycle, false);
  const result = health.claimRecycleIfDue({ at: 301_000 });
  assert.equal(result.shouldRecycle, true);
  assert.equal(result.snapshot.state, 'recycling');
  assert.equal(result.snapshot.errorCount, 1);
  assert.equal(result.snapshot.recycleIssued, true);
  assert.equal(result.snapshot.recycleDueAt, null);

  const repeated = health.claimRecycleIfDue({ at: DEFAULT_GATEWAY_RECYCLE_AFTER_MS + 10_000 });
  assert.equal(repeated.shouldRecycle, false);
});

test('Gateway health rate-limits error logs and keeps the incident across a quiet gap', () => {
  const health = new DiscordGatewayHealth();
  health.markReady({ at: 0, shardId: 0 });
  const first = health.recordError(new Error('Unexpected server response: 503'), { at: 1_000, shardId: 0 });
  const second = health.recordError(new Error('Unexpected server response: 503'), { at: 20_000, shardId: 0 });
  health.recordError(new Error('Unexpected server response: 503'), { at: 40_000, shardId: 0 });
  const summary = health.recordError(new Error('Unexpected server response: 503'), { at: 61_000, shardId: 0 });
  assert.equal(first.shouldLog, true);
  assert.equal(second.shouldLog, false);
  assert.equal(summary.shouldLog, true);
  assert.equal(summary.suppressedErrors, 2);
  assert.equal(summary.snapshot.ready, false);

  const recovered = health.markReady({ at: 62_000, shardId: 0 });
  assert.equal(recovered.recovery.errorCount, 4);
  assert.equal(recovered.snapshot.state, 'ready');
  assert.equal(recovered.snapshot.errorCount, 0);

  health.recordError(new Error('Unexpected server response: 503'), { at: 70_000, shardId: 0 });
  const afterGap = health.recordError(new Error('Unexpected server response: 503'), { at: 101_000, shardId: 0 });
  assert.equal(afterGap.snapshot.errorCount, 2);
  assert.equal(afterGap.snapshot.firstErrorAt, new Date(70_000).toISOString());
});

test('Gateway recovery cancels a pending deadline claim', () => {
  const health = new DiscordGatewayHealth();
  health.markReady({ at: 0, shardId: 0 });
  health.recordError(new Error('Opening handshake has timed out'), { at: 1_000, shardId: 0 });
  health.markReady({ at: 20_000, shardId: 0 });
  assert.equal(health.claimRecycleIfDue({ at: 301_000 }).shouldRecycle, false);
});

test('non-transient Gateway errors remain visible without entering automatic recycle state', () => {
  const health = new DiscordGatewayHealth();
  health.markReady({ at: 0, shardId: 0 });
  const result = health.recordError(new Error('Authentication failed'), { at: 1_000, shardId: 0 });
  assert.equal(result.tracked, false);
  assert.equal(result.shouldLog, true);
  assert.equal(result.shouldRecycle, false);
  assert.equal(result.snapshot.state, 'failed');
  assert.equal(result.snapshot.ready, false);
});

test('Gateway recycle timeout cannot be configured below five minutes', () => {
  assert.throws(
    () => new DiscordGatewayHealth({ recycleAfterMs: DEFAULT_GATEWAY_RECYCLE_AFTER_MS - 1 }),
    /at least 300000ms/,
  );
});
