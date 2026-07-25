import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  isTaskVisualizationRoot,
  readSessionWorkspaceRoots,
} from '../src/session-workspace-roots.mjs';

test('reads only the latest workspace roots from the matching Codex session', async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-session-roots-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const sessionPath = path.join(directory, 'rollout.jsonl');
  fs.writeFileSync(sessionPath, [
    JSON.stringify({ type: 'session_meta', payload: { id: 'thread-1' } }),
    JSON.stringify({ type: 'turn_context', payload: { workspace_roots: ['C:\\old'] } }),
    '{invalid json',
    JSON.stringify({
      type: 'turn_context',
      payload: { workspace_roots: ['C:\\project', { path: 'C:\\runtime' }, 'c:\\PROJECT\\'] },
    }),
  ].join('\n'));

  assert.deepEqual(
    await readSessionWorkspaceRoots(sessionPath, 'thread-1'),
    ['C:\\project', 'C:\\runtime'],
  );
  assert.deepEqual(await readSessionWorkspaceRoots(sessionPath, 'different-thread'), []);
});

test('recognizes only the exact task-scoped Codex visualization root', () => {
  const codexHome = 'C:\\Users\\example\\.codex';
  const threadId = '019f-example';
  const root = `${codexHome}\\visualizations\\2026\\07\\25\\${threadId}`;

  assert.equal(isTaskVisualizationRoot(root, threadId, codexHome), true);
  assert.equal(isTaskVisualizationRoot(`${root}\\nested`, threadId, codexHome), false);
  assert.equal(isTaskVisualizationRoot(root, 'different-thread', codexHome), false);
  assert.equal(isTaskVisualizationRoot(`${codexHome}\\sessions\\${threadId}`, threadId, codexHome), false);
});
