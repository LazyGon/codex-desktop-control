import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discoverEndpoint } from '../src/config.mjs';

test('configured shared-launcher state takes precedence over a stale environment endpoint', (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-endpoint-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const statePath = path.join(directory, 'current.json');
  fs.writeFileSync(statePath, JSON.stringify({ websocketUrl: 'ws://127.0.0.1:18898' }));
  const previous = process.env.CODEX_APP_SERVER_WS_URL;
  context.after(() => {
    if (previous === undefined) delete process.env.CODEX_APP_SERVER_WS_URL;
    else process.env.CODEX_APP_SERVER_WS_URL = previous;
  });
  process.env.CODEX_APP_SERVER_WS_URL = 'ws://127.0.0.1:18897';
  assert.deepEqual(discoverEndpoint({ launcherStatePath: statePath }), { url: 'ws://127.0.0.1:18898', source: statePath });
  assert.deepEqual(discoverEndpoint({ launcherStatePath: statePath, appServerUrl: 'ws://127.0.0.1:18896' }),
    { url: 'ws://127.0.0.1:18896', source: 'config' });
  fs.writeFileSync(statePath, JSON.stringify({ websocketUrl: 'ws://100.64.0.1:8798' }));
  assert.throws(() => discoverEndpoint({ launcherStatePath: statePath }), /loopback/);
});
