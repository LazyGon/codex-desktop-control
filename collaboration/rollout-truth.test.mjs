import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rolloutOutcome, rolloutTurn } from './rollout-truth.mjs';
import { createOperationNotifier } from '../state/claude-orchestration/operation-notifier.mjs';

test('only the exact complete lifecycle event ends a turn; partial appends stay pending', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rollout-truth-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'rollout.jsonl');
  const event = (type, turn_id, extra = {}) => JSON.stringify({ type: 'event_msg', payload: { type, turn_id, ...extra } });
  fs.writeFileSync(file, event('task_started', 'target') + '\n' + event('task_complete', 'other', { last_agent_message: 'wrong turn' }) + '\n');
  assert.equal(rolloutOutcome('thread', 'target', { file }), null);
  const final = event('task_complete', 'target', { last_agent_message: '確定した回答' });
  fs.appendFileSync(file, final);
  assert.equal(rolloutOutcome('thread', 'target', { file }), null);
  fs.appendFileSync(file, '\n' + event('task_started', 'later') + '\n');
  assert.deepEqual(rolloutOutcome('thread', 'target', { file }), { type: 'task_complete', answer: '確定した回答' });
  assert.equal(rolloutTurn('thread', null, { file }).id, 'later');
  fs.appendFileSync(file, event('turn_aborted', 'later') + '\n');
  assert.deepEqual(rolloutOutcome('thread', 'later', { file }), { type: 'turn_aborted', answer: '' });
});

test('notifier never turns an old waiter failure into task completion; delivery phases stay distinct', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'truth-notifier-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const resultsDirectory = path.join(directory, 'results');
  const records = {
    stale: { phase: 'failed', status: 'inProgress', threadId: 'missing-thread', turnId: 'still-running', startedAt: '2000-01-01T00:00:00Z' },
    missing: { phase: 'result-unavailable', threadId: 'missing-thread', turnId: 'lagging' },
    rejected: { phase: 'not-delivered', threadId: 'missing-thread' },
    uncertain: { phase: 'unknown', threadId: 'missing-thread' },
    failed: { phase: 'failed', status: 'failed', verifiedBy: 'thread/read', threadId: 'missing-thread', turnId: 'truly-ended' },
  };
  for (const [id, result] of Object.entries(records)) {
    fs.writeFileSync(path.join(directory, id + '.json'), '{}');
    fs.mkdirSync(path.join(resultsDirectory, id), { recursive: true });
    fs.writeFileSync(path.join(resultsDirectory, id, 'result.json'), JSON.stringify(result));
  }
  const notices = [];
  const poll = createOperationNotifier({ directory, resultsDirectory, log() {}, notify: async text => {
    notices.push(text); return { code: 0, isError: false };
  } });
  await poll();
  assert.equal(notices.length, 1);
  assert.doesNotMatch(notices[0], /Codex依頼 (stale|missing)/);
  assert.match(notices[0], /未配送・再配送可能/);
  assert.match(notices[0], /配送結果不明・再送禁止/);
  assert.match(notices[0], /failed で終了/);
});
