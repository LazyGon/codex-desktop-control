import test from 'node:test';
import assert from 'node:assert/strict';
import {
  completedTurnsSince,
  epochMilliseconds,
  historicalAssistantItems,
  RECENT_HISTORY_DAY_OPTIONS,
  recentHistoryCutoffMs,
  turnTimestampMs,
  uuidV7TimestampMs,
} from '../src/recent-history.mjs';

test('recent history limits restore choices to one, three, or seven days', () => {
  assert.deepEqual(RECENT_HISTORY_DAY_OPTIONS, [1, 3, 7]);
  assert.equal(recentHistoryCutoffMs(7, 10 * 24 * 60 * 60 * 1000), 3 * 24 * 60 * 60 * 1000);
  assert.throws(() => recentHistoryCutoffMs(8), /1、3、7/);
});

test('turn timestamps accept app-server seconds, milliseconds, ISO text, and UUIDv7 fallback', () => {
  assert.equal(epochMilliseconds(1_785_000_000), 1_785_000_000_000);
  assert.equal(epochMilliseconds(1_785_000_000_123), 1_785_000_000_123);
  assert.equal(epochMilliseconds('2026-07-27T00:00:00.000Z'), Date.parse('2026-07-27T00:00:00.000Z'));
  assert.equal(turnTimestampMs({ completedAt: 1_785_000_000, startedAt: 1 }), 1_785_000_000_000);
  assert.equal(uuidV7TimestampMs('019fa0af-9502-7951-8eb4-e5bddc8da5b4'), 1_785_107_289_346);
  assert.equal(turnTimestampMs({ id: '019fa0af-9502-7951-8eb4-e5bddc8da5b4' }), 1_785_107_289_346);
  assert.equal(turnTimestampMs({ id: 'not-a-uuid' }), null);
});

test('recent completed turns exclude active, old, and undated turns', () => {
  const cutoff = 2_000_000;
  const turns = [
    { id: 'old', status: 'completed', completedAt: 1_999 },
    { id: 'boundary', status: 'completed', completedAt: 2_000 },
    { id: 'new', status: 'failed', completedAt: 2_001 },
    { id: 'active', status: 'inProgress', startedAt: 2_002 },
    { id: 'unknown', status: 'completed' },
  ];
  assert.deepEqual(completedTurnsSince(turns, cutoff).map((turn) => turn.id), ['boundary', 'new']);
});

test('historical details expose commentary and reasoning summaries without raw reasoning content', () => {
  const items = historicalAssistantItems({
    items: [
      { type: 'agentMessage', id: 'comment-1', phase: 'commentary', text: '進行中です。' },
      { type: 'reasoning', id: 'reason-1', summary: ['確認した。', '確認した。', '次へ進む。'], content: ['raw-private'] },
      { type: 'agentMessage', id: 'final-1', phase: 'final_answer', text: '完了。' },
      { type: 'reasoning', id: 'reason-empty', summary: [], content: ['raw-private'] },
    ],
  });
  assert.deepEqual(items.map((item) => ({
    id: item.id,
    phase: item.phase,
    text: item.text,
  })), [
    { id: 'comment-1', phase: 'commentary', text: '進行中です。' },
    { id: 'reason-1', phase: 'reasoning', text: '確認した。\n次へ進む。' },
  ]);
  assert.equal(items.some((item) => item.text.includes('raw-private')), false);
});
