import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const launcherRoot = path.dirname(fileURLToPath(import.meta.url));
const helperPath = path.join(launcherRoot, 'CodexRuntimeCache.ps1');

function psLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex').toUpperCase();
}

function initializeCache({ server, host, cache, version }) {
  const command = [
    `$ErrorActionPreference = 'Stop'`,
    `. ${psLiteral(helperPath)}`,
    `$result = Initialize-CodexRuntimeCache -BundledServerExecutable ${psLiteral(server)} -BundledCodeModeHostExecutable ${psLiteral(host)} -CacheRoot ${psLiteral(cache)} -PackageVersion ${psLiteral(version)}`,
    `$result | ConvertTo-Json -Compress`,
  ].join('\n');
  return JSON.parse(execFileSync('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    command,
  ], { encoding: 'utf8' }));
}

test('runtime cache keeps app-server and Code Mode host together per package version', (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-runtime-cache-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'source');
  const cache = path.join(directory, 'cache');
  fs.mkdirSync(source);
  const server = path.join(source, 'codex.exe');
  const host = path.join(source, 'codex-code-mode-host.exe');
  fs.writeFileSync(server, 'server-v1');
  fs.writeFileSync(host, 'host-v1');

  const first = initializeCache({ server, host, cache, version: '26.803.1.0' });
  assert.equal(path.basename(first.ServerExecutable), 'codex.exe');
  assert.equal(path.basename(first.CodeModeHostExecutable), 'codex-code-mode-host.exe');
  assert.equal(path.dirname(first.ServerExecutable), path.dirname(first.CodeModeHostExecutable));
  assert.equal(first.ServerSha256, sha256('server-v1'));
  assert.equal(first.CodeModeHostSha256, sha256('host-v1'));
  assert.equal(fs.readFileSync(first.CodeModeHostExecutable, 'utf8'), 'host-v1');

  fs.writeFileSync(host, 'host-v1-repaired');
  const repaired = initializeCache({ server, host, cache, version: '26.803.1.0' });
  assert.equal(repaired.CodeModeHostSha256, sha256('host-v1-repaired'));
  assert.equal(fs.readFileSync(repaired.CodeModeHostExecutable, 'utf8'), 'host-v1-repaired');

  fs.writeFileSync(server, 'server-v2');
  fs.writeFileSync(host, 'host-v2');
  const second = initializeCache({ server, host, cache, version: '26.804.1.0' });
  assert.notEqual(path.dirname(second.ServerExecutable), path.dirname(first.ServerExecutable));
  assert.equal(fs.readFileSync(first.ServerExecutable, 'utf8'), 'server-v1');
  assert.equal(fs.readFileSync(first.CodeModeHostExecutable, 'utf8'), 'host-v1-repaired');
  assert.equal(fs.readFileSync(second.ServerExecutable, 'utf8'), 'server-v2');
  assert.equal(fs.readFileSync(second.CodeModeHostExecutable, 'utf8'), 'host-v2');
});
