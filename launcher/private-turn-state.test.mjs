import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { lifecycleFromText, inspectPrivateTurns } from './private-turn-state.mjs';

const since = Date.parse('2026-09-27T17:00:00Z');
const line = (type, turn_id = 'one', timestamp = '2026-09-27T17:00:01Z') => JSON.stringify({ type: 'event_msg', timestamp, payload: { type, turn_id } });
test('requires a terminal event for the exact turn, not a final-looking message', () => {
  const result = lifecycleFromText([line('task_started'), line('agent_message'), line('task_complete', 'other')].join('\n'), since);
  assert.equal(result.get('one'), 'task_started');
});
test('completion and cancellation are distinct', () => {
  const result = lifecycleFromText([line('task_started'), line('task_complete'), line('turn_aborted', 'other')].join('\n'), since);
  assert.equal(result.get('one'), 'task_complete');
  assert.equal(result.get('other'), 'turn_aborted');
});
test('new work after completion is still active', () => {
  const result = lifecycleFromText([line('task_complete'), line('task_started', 'new')].join('\n'), since);
  assert.equal(result.get('new'), 'task_started');
});
test('ignores old lifecycle events and untrusted tool strings', () => {
  const fake = JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output', output: line('task_started') } });
  const result = lifecycleFromText([line('task_started', 'old', '2026-09-26T17:00:00Z'), fake].join('\n'), since);
  assert.equal(result.size, 0);
});
test('incomplete final JSON is retried but complete corrupt JSON fails closed', () => {
  assert.equal(lifecycleFromText(`${line('task_started')}\n{"type":"event_msg"`, since).get('one'), 'task_started');
  assert.throws(() => lifecycleFromText('{"type":"event_msg"\n\n', since));
});
test('real directory scan finds other work and requires the exact source task/turn', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-private-turn-test-'));
  const threadId = '11111111-1111-1111-1111-111111111111';
  const otherId = '22222222-2222-2222-2222-222222222222';
  const directory = path.join(root, '2026', '09', '28');
  await fs.mkdir(directory, { recursive: true });
  const sourcePath = path.join(directory, `rollout-${threadId}.jsonl`);
  const otherPath = path.join(directory, `rollout-${otherId}.jsonl`);
  try {
    await fs.writeFile(sourcePath, `${line('task_started')}\n${line('task_complete')}\n`);
    await fs.writeFile(otherPath, `${line('task_started', 'other')}\n`);
    const options = { sessionsRoot: root, sourcePath, threadId, turnId: 'one', since: new Date(since).toISOString() };
    assert.deepEqual(await inspectPrivateTurns(options), { threadId, turnId: 'one', sourceStatus: 'task_complete', activeThreadIds: [otherId] });
    await assert.rejects(inspectPrivateTurns({ ...options, turnId: 'missing' }));
    await assert.rejects(inspectPrivateTurns({ ...options, threadId: otherId }));
    await fs.appendFile(otherPath, `${line('task_complete', 'other')}\n`);
    assert.deepEqual((await inspectPrivateTurns(options)).activeThreadIds, []);
  } finally {
    // Only the exact temporary directory created by this test is removed.
    await fs.rm(root, { recursive: true, force: true });
  }
});
