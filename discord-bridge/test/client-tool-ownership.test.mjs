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

test('headless ownership requires a known local server generation and confirmed Desktop absence', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-headless-owner-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const launcherStatePath = path.join(directory, 'current.json');
  const state = {
    websocketUrl: 'ws://127.0.0.1:8798', serverProcessId: 100,
    startedAt: '2026-11-11T00:00:00Z', mode: 'server',
    desktopProcessIds: [], desktopConnectionVerified: false,
  };
  const inspect = (patch = {}, probe = (pid) => pid === 100) => {
    fs.writeFileSync(launcherStatePath, JSON.stringify({ ...state, ...patch }));
    return inspectDesktopClientOwner({ launcherStatePath, appServerUrl: state.websocketUrl, isProcessAlive: probe });
  };
  assert.equal(inspect().state, 'absent');
  assert.equal(inspect({ mode: 'desktop', desktopProcessIds: [200] }).state, 'absent');
  for (const patch of [
    { desktopProcessIds: undefined }, { desktopProcessIds: [0] }, { desktopProcessIds: ['200'] },
    { serverProcessId: 0 }, { startedAt: undefined }, { startedAt: 'unknown' },
    { mode: undefined }, { mode: 'other-runtime' },
    { websocketUrl: 'ws://127.0.0.1:9999' },
  ]) assert.equal(inspect(patch).state, 'ambiguous');
  for (const result of [null, undefined, 'unknown']) {
    assert.equal(inspect({ desktopProcessIds: [200] }, (pid) => pid === 100 ? true : result).state, 'ambiguous');
    assert.equal(inspect({}, () => result).state, 'ambiguous');
  }
  assert.equal(inspect({ desktopProcessIds: [200] }, () => { throw new Error('process inspection denied'); }).state, 'ambiguous');
  assert.equal(inspect({ desktopProcessIds: [200] }, () => true).state, 'ambiguous');
  for (const endpoint of ['ws://remote.example:8798', 'http://127.0.0.1:8798', 'ws://user@127.0.0.1:8798']) {
    fs.writeFileSync(launcherStatePath, JSON.stringify({ ...state, websocketUrl: endpoint }));
    assert.equal(inspectDesktopClientOwner({ launcherStatePath, appServerUrl: endpoint, isProcessAlive: () => true }).state, 'ambiguous');
  }
  fs.writeFileSync(launcherStatePath, '{');
  assert.equal(inspectDesktopClientOwner({ launcherStatePath, appServerUrl: state.websocketUrl }).state, 'ambiguous');
});
