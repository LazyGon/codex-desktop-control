import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { runRequest } from './peer.mjs';

// Exercise the public request boundary through the actual creation code, stopping
// before delivery so these tests cannot run another agent or require inference.
for (const [label, selection] of [
  ['explicit project', { projectId: 'selected-project' }],
  ['explicit projectless', { projectId: null }],
  ['unspecified project', {}],
]) {
  test(`create:true preserves ${label} at the AppServer boundary`, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'peer-project-'));
    const calls = [];
    let closed = false;
    const workspace = process.cwd();
    const client = {
      call: async (method, params) => {
        calls.push({ method, params });
        if (method === 'thread/start') return { thread: { id: 'new-thread' } };
        if (method === 'thread/read') return { thread: { id: 'new-thread', cwd: workspace } };
        throw new Error('TEST_STOP_AFTER_CREATION');
      },
      close: () => { closed = true; },
    };
    try {
      const messageFile = path.join(directory, 'message.txt');
      fs.writeFileSync(messageFile, 'Creation test');
      const runtimeFile = path.join(directory, 'runtime.json');
      fs.writeFileSync(runtimeFile, '{}');
      const result = await runRequest({
        operationId: randomUUID(), peer: 'codex', create: true, workspace,
        mode: 'implement', messageFile, ...selection,
      }, {
        stateRoot: path.join(directory, 'operations'),
        connect: async () => ({ client, runtime: { statePath: runtimeFile } }),
        routeFactory: () => ({}),
      });
      assert.equal(result.threadId, 'new-thread');
      assert.equal(result.error, 'TEST_STOP_AFTER_CREATION');
      const starts = calls.filter(call => call.method === 'thread/start');
      assert.equal(starts.length, 1);
      assert.deepEqual(starts[0].params, { cwd: workspace, model: 'gpt-6.1-sol', ...selection });
      assert.equal(calls.some(call => call.method.startsWith('turn/')), false);
      assert.equal(closed, true);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
}
