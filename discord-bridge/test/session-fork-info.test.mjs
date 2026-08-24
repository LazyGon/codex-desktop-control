import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readSessionForkInfo } from '../src/session-fork-info.mjs';

test('session fork metadata identifies the source without reading copied history', async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-session-fork-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const sessionPath = path.join(directory, 'rollout.jsonl');
  fs.writeFileSync(sessionPath, [
    JSON.stringify({
      timestamp: '2026-08-24T10:34:25.428Z',
      type: 'session_meta',
      payload: { id: 'forked-thread', forked_from_id: 'source-thread' },
    }),
    '{copied history deliberately need not be valid JSON}',
  ].join('\n'), 'utf8');

  assert.deepEqual(await readSessionForkInfo(sessionPath, 'forked-thread'), {
    forkedFromThreadId: 'source-thread',
    forkedAtMs: Date.parse('2026-08-24T10:34:25.428Z'),
  });
  assert.equal(await readSessionForkInfo(sessionPath, 'different-thread'), null);
});
