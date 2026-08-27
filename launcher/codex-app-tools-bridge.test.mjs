import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  assertSharedServerOwner,
  derivePackageFamilyName,
  parseRuntimeState,
  resolveBundledPaths,
  selectDesktopConnection,
  selectNativePipeFromLogs,
  waitForBridgeRuntime,
} from './codex-app-tools-bridge.mjs';

function validState(overrides = {}) {
  return {
    port: 8798,
    websocketUrl: 'ws://127.0.0.1:8798',
    readyUrl: 'http://127.0.0.1:8798/readyz',
    serverProcessId: 987,
    desktopExecutable: String.raw`C:\Program Files\WindowsApps\OpenAI.Codex_26.900.1.0_x64__2p2nqsd0c76g0\app\ChatGPT.exe`,
    serverExecutable: String.raw`C:\runtime\codex.exe`,
    packageVersion: '26.900.1.0',
    desktopConnectionVerified: true,
    ...overrides,
  };
}

test('shared bridge accepts only a verified exact loopback runtime', () => {
  assert.equal(parseRuntimeState(JSON.stringify(validState())).port, 8798);
  assert.throws(
    () => parseRuntimeState(JSON.stringify(validState({ websocketUrl: 'ws://0.0.0.0:8798' }))),
    /loopback WebSocket/,
  );
  assert.throws(
    () => parseRuntimeState(JSON.stringify(validState({ desktopConnectionVerified: false }))),
    /verified Desktop connection/,
  );
});

test('shared bridge requires the exact loopback App Server owner', () => {
  const executable = validState().serverExecutable;
  assert.doesNotThrow(() => assertSharedServerOwner({
    listenerProcessIds: [987],
    server: { processId: 987, executablePath: executable },
  }, 987, executable));
  assert.throws(() => assertSharedServerOwner({
    listenerProcessIds: [654],
    server: { processId: 987, executablePath: executable },
  }, 987, executable), /listener owner/);
  assert.throws(() => assertSharedServerOwner({
    listenerProcessIds: [987],
    server: { processId: 987, executablePath: String.raw`C:\foreign\codex.exe` },
  }, 987, executable), /exact recorded executable/);
});

test('shared bridge fails closed unless one exact Desktop owns the connection', () => {
  const executable = validState().desktopExecutable;
  const one = selectDesktopConnection({ matches: [{
    processId: 123,
    executablePath: executable.toLowerCase(),
    creationTimeUtc: '2026-08-27T19:46:54.872Z',
  }] }, executable);
  assert.equal(one.processId, 123);
  assert.throws(
    () => selectDesktopConnection({ matches: [] }, executable),
    /exactly one Desktop process.*found 0/,
  );
  assert.throws(
    () => selectDesktopConnection({ matches: [
      { ...one, processId: 123 },
      { ...one, processId: 456 },
    ] }, executable),
    /exactly one Desktop process.*found 2/,
  );
});

test('shared bridge binds the native pipe to the current main-process log', (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-app-tools-log-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const current = path.join(directory, 'codex-desktop-id-4321-t0-i1-194654-0.log');
  const renderer = path.join(directory, 'codex-desktop-id-4321-t1-i1-194703-0.log');
  const stale = path.join(directory, 'codex-desktop-id-99-t0-i1-180000-0.log');
  fs.writeFileSync(current, [
    '2026-08-27T19:46:54.872Z info Launching app',
    String.raw`2026-08-27T19:46:55.094Z info [dynamic-app-tools-native-pipe] dynamic_app_tools_listening pipePath=\\.\pipe\codex-browser-use-11111111-2222-3333-4444-555555555555`,
  ].join('\n'));
  fs.writeFileSync(renderer, 'renderer');
  fs.writeFileSync(stale, String.raw`2026-08-27T18:00:01.000Z info [dynamic-app-tools-native-pipe] dynamic_app_tools_listening pipePath=\\.\pipe\codex-browser-use-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa`);

  const result = selectNativePipeFromLogs(
    [renderer, stale, current],
    4321,
    '2026-08-27T19:46:54.800Z',
  );
  assert.equal(result.logPath, current);
  assert.equal(
    result.pipePath,
    String.raw`\\.\pipe\codex-browser-use-11111111-2222-3333-4444-555555555555`,
  );
  assert.throws(
    () => selectNativePipeFromLogs([current], 4321, '2026-08-27T20:46:54.800Z'),
    /No current native app-tools pipe/,
  );
});

test('shared bridge derives and verifies the installed Desktop plugin layout', (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-app-tools-package-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const installRoot = path.join(
    directory,
    'OpenAI.Codex_26.900.1.0_x64__2p2nqsd0c76g0',
  );
  const desktop = path.join(installRoot, 'app', 'ChatGPT.exe');
  const resources = path.join(installRoot, 'app', 'resources');
  const plugin = path.join(
    resources,
    'plugins',
    'openai-bundled',
    'plugins',
    'codex-app-tools',
  );
  for (const file of [
    desktop,
    path.join(resources, 'cua_node', 'bin', 'node.exe'),
    path.join(plugin, 'server.mjs'),
    path.join(plugin, 'scripts', 'launch_codex_app_tools_mcp.cmd'),
  ]) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'fixture');
  }
  fs.writeFileSync(path.join(plugin, 'desktop-mcp.json'), JSON.stringify({
    mcpServers: {
      codex_app: {
        command: 'cmd.exe',
        args: [
          '/d', '/s', '/c', 'call',
          './scripts/launch_codex_app_tools_mcp.cmd',
          './server.mjs',
        ],
      },
    },
  }));

  assert.equal(derivePackageFamilyName(desktop), 'OpenAI.Codex_2p2nqsd0c76g0');
  assert.equal(resolveBundledPaths(desktop).pluginRoot, plugin);
});

test('shared bridge allows a bounded startup race without accepting uncertainty', async () => {
  let attempts = 0;
  const resolved = await waitForBridgeRuntime({
    resolve: () => {
      attempts += 1;
      if (attempts < 3) throw new Error('Desktop state is not ready yet.');
      return { ready: true };
    },
    timeoutMilliseconds: 100,
    retryMilliseconds: 1,
  });
  assert.deepEqual(resolved, { ready: true });
  assert.equal(attempts, 3);

  await assert.rejects(
    waitForBridgeRuntime({
      resolve: () => { throw new Error('ambiguous live owner'); },
      timeoutMilliseconds: 5,
      retryMilliseconds: 1,
    }),
    /did not become safe.*ambiguous live owner/,
  );
});
