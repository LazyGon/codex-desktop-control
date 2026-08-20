import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildRemoteArguments,
  readyTimeoutMilliseconds,
  validateLoopbackEndpoint,
  validateSharedRuntime,
} from './codex-shared.mjs';

function fixture(context, overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-shared-cli-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const executable = path.join(directory, 'codex.exe');
  fs.writeFileSync(executable, 'shared-codex-fixture');
  const serverSha256 = createHash('sha256')
    .update(fs.readFileSync(executable))
    .digest('hex')
    .toUpperCase();
  const statePath = path.join(directory, 'current.json');
  const state = {
    schemaVersion: 2,
    websocketUrl: 'ws://127.0.0.1:8798',
    serverProcessId: 1234,
    serverExecutable: executable,
    serverSha256,
    desktopConnectionVerified: true,
    packageVersion: 'test-package',
    ...overrides,
  };
  fs.writeFileSync(statePath, JSON.stringify(state), 'utf8');
  return { statePath, state };
}

test('shared CLI accepts only the launcher loopback endpoint', () => {
  assert.equal(validateLoopbackEndpoint('ws://127.0.0.1:8798'), 'ws://127.0.0.1:8798');
  assert.throws(() => validateLoopbackEndpoint('ws://0.0.0.0:8798'), /non-loopback/);
  assert.throws(() => validateLoopbackEndpoint('wss://127.0.0.1:8798'), /non-loopback/);
  assert.throws(() => validateLoopbackEndpoint('ws://127.0.0.1:8798/other'), /non-loopback/);
});

test('shared CLI validates state, executable identity, process, and readiness', async context => {
  const { statePath, state } = fixture(context);
  const requestedUrls = [];
  const runtime = await validateSharedRuntime({
    statePath,
    fetchImplementation: async url => {
      requestedUrls.push(url);
      return { status: 200 };
    },
    timeoutMilliseconds: 100,
    isProcessAlive: processId => processId === state.serverProcessId,
  });

  assert.equal(runtime.endpoint, state.websocketUrl);
  assert.equal(runtime.serverExecutable, state.serverExecutable);
  assert.deepEqual(requestedUrls, ['http://127.0.0.1:8798/readyz']);
});

test('shared CLI rejects a stale executable hash and unverified Desktop', async context => {
  const stale = fixture(context, { serverSha256: '0'.repeat(64) });
  await assert.rejects(
    validateSharedRuntime({
      statePath: stale.statePath,
      fetchImplementation: async () => ({ status: 200 }),
      timeoutMilliseconds: 100,
      isProcessAlive: () => true,
    }),
    /SHA-256/,
  );

  const unverified = fixture(context, { desktopConnectionVerified: false });
  await assert.rejects(
    validateSharedRuntime({
      statePath: unverified.statePath,
      fetchImplementation: async () => ({ status: 200 }),
      timeoutMilliseconds: 100,
      isProcessAlive: () => true,
    }),
    /Desktop connection/,
  );
});

test('shared CLI owns the remote endpoint and uses a five-minute readiness window', () => {
  assert.equal(readyTimeoutMilliseconds, 300_000);
  assert.deepEqual(buildRemoteArguments(['--no-alt-screen', 'continue this task']), [
    '--no-alt-screen',
    'continue this task',
  ]);
  assert.throws(() => buildRemoteArguments(['--remote', 'ws://127.0.0.1:9000']), /not allowed/);
  assert.throws(() => buildRemoteArguments(['--remote=wss://example.com']), /not allowed/);
  assert.throws(() => buildRemoteArguments(['--remote-auth-token-env=TOKEN']), /not allowed/);
});
