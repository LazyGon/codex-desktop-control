import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  clientToolRequestKey,
  inspectDesktopClientOwner,
  requiresExclusiveClientToolOwner,
} from '../src/client-tool-ownership.mjs';

test('only known read-only codex_app tools can run without an exclusive owner', () => {
  for (const tool of [
    'list_projects',
    'list_threads',
    'load_workspace_dependencies',
    'read_thread',
  ]) {
    assert.equal(requiresExclusiveClientToolOwner('codex_app', tool), false);
  }
  for (const tool of [
    'automation_update',
    'send_message_to_thread',
    'set_thread_archived',
    'set_thread_title',
    'fork_thread',
    'create_thread',
    'unknown_future_tool',
  ]) {
    assert.equal(requiresExclusiveClientToolOwner('codex_app', tool), true);
  }
  assert.equal(requiresExclusiveClientToolOwner('external_connector', 'send'), false);
});

test('Desktop owner inspection distinguishes present, absent, and ambiguous state', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-desktop-owner-'));
  const launcherStatePath = path.join(directory, 'current.json');
  try {
    fs.writeFileSync(launcherStatePath, JSON.stringify({
      websocketUrl: 'ws://localhost:8798/',
      serverProcessId: 100,
      desktopProcessIds: [200, 201],
      desktopConnectionVerified: true,
      mode: 'desktop',
      startedAt: '2026-08-08T00:00:00Z',
    }));
    const present = inspectDesktopClientOwner({
      launcherStatePath,
      appServerUrl: 'ws://127.0.0.1:8798',
      isProcessAlive: (processId) => [100, 201].includes(processId),
    });
    assert.equal(present.state, 'present');
    assert.match(present.generation, /\|100\|2026-08-08/);

    const absent = inspectDesktopClientOwner({
      launcherStatePath,
      appServerUrl: 'ws://127.0.0.1:8798',
      isProcessAlive: (processId) => processId === 100,
    });
    assert.equal(absent.state, 'absent');

    const mismatch = inspectDesktopClientOwner({
      launcherStatePath,
      appServerUrl: 'ws://127.0.0.1:9999',
      isProcessAlive: () => true,
    });
    assert.deepEqual(mismatch, {
      state: 'ambiguous',
      generation: null,
      reason: 'app-server-endpoint-mismatch',
    });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('client tool request key includes app-server generation and request identity', () => {
  assert.equal(clientToolRequestKey('server-generation', 42), 'server-generation|request:42');
});
