import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { retireThread } from './retire-threads.mjs';
import { createOperationNotifier } from './operation-notifier.mjs';

for (const [id, snapshot] of [
  ['01a0e82f-1781-7881-b011-348df7758c19', null],
  ['01a0e82f-1e78-7cc1-91b5-f08817e510b8', null],
  ['active-worker', { thread: { id: 'active-worker', status: { type: 'active' } }, turn: { status: 'completed' } }],
  ['blocked-worker', { thread: { id: 'blocked-worker', status: { type: 'idle' } }, turn: { status: 'completed' }, goal: { status: 'blocked' } }],
]) test('never deletes ' + id, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'retirement-test-'));
  try {
    let deletes = 0;
    const result = await retireThread(id, { directory,
      client: { call() { deletes++; throw new Error('must not call delete'); } },
      inspect: async () => snapshot,
      answer: async () => { throw new Error('must refuse before preservation'); },
    });
    assert.equal(result.phase, 'kept');
    assert.equal(deletes, 0);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('notifier retires only opted-in operations after successful notice, once', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'retirement-notifier-'));
  try {
    const resultsDirectory = path.join(directory, 'results');
    for (const [id, retire] of [['opt-in', true], ['default', undefined]]) {
      fs.writeFileSync(path.join(directory, id + '.json'), JSON.stringify({ retire }));
      fs.mkdirSync(path.join(resultsDirectory, id), { recursive: true });
      fs.writeFileSync(path.join(resultsDirectory, id, 'result.json'), JSON.stringify({ phase: 'completed', threadId: id }));
    }
    const events = []; let time = 0; let success = false;
    const options = { directory, resultsDirectory, log() {}, now: () => time,
      notify: async () => { events.push('notice'); return { code: success ? 0 : 1, isError: !success }; },
      retire: async id => { assert.ok(fs.existsSync(path.join(directory, '.notified', id))); events.push('retire:' + id); return { phase: 'kept' }; },
    };
    let poll = createOperationNotifier(options);
    await poll(); assert.deepEqual(events, ['notice']);
    time = 16 * 60_000; success = true;
    await poll(); assert.deepEqual(events, ['notice', 'notice', 'retire:opt-in']);
    poll = createOperationNotifier(options); time += 16 * 60_000;
    await poll(); assert.deepEqual(events, ['notice', 'notice', 'retire:opt-in']);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
