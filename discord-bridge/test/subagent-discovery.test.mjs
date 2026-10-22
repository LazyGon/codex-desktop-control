import test from 'node:test';
import assert from 'node:assert/strict';
import { mirroredDescendants } from '../src/subagent-discovery.mjs';
import { CodexService } from '../src/codex-service.mjs';

test('metadata discovery keeps nested descendants, excludes foreign and ephemeral threads, and terminates cycles', () => {
  const threads = [
    { id: 'grandchild', parentThreadId: 'child' },
    { id: 'foreign', parentThreadId: 'other' },
    { id: 'child', source: { subAgent: { thread_spawn: { parent_thread_id: 'root' } } } },
    { id: 'temporary', parentThreadId: 'root', ephemeral: true },
    { id: 'root', parentThreadId: 'grandchild' },
  ];
  assert.deepEqual(mirroredDescendants(threads, ['root']).map(t => t.id), ['child', 'grandchild']);
  assert.deepEqual(mirroredDescendants(threads, ['absent']), []);
});

test('child discovery includes archived pages without loading any conversation body', async () => {
  const service = new CodexService({ config: {}, stateStore: {}, logDir: '.' });
  service.client = { connected: true, async call(method, params) {
    assert.equal(method, 'thread/list');
    assert.equal(params.useStateDbOnly, true);
    assert.deepEqual(params.sourceKinds, ['subAgent']);
    if (!params.archived) return { data: [{ id: 'live' }], nextCursor: null };
    return params.cursor === 'older'
      ? { data: [{ id: 'old' }], nextCursor: null }
      : { data: [{ id: 'archived' }], nextCursor: 'older' };
  } };
  assert.deepEqual((await service.listSubagentThreads()).map(t => t.id), ['live', 'archived', 'old']);
});

test('a repeated metadata cursor fails rather than looping or claiming complete discovery', async () => {
  const service = new CodexService({ config: {}, stateStore: {}, logDir: '.' });
  service.client = { connected: true, async call() { return { data: [], nextCursor: 'same' }; } };
  await assert.rejects(service.listSubagentThreads(), /repeated cursor/);
});
