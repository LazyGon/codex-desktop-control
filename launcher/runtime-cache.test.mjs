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

function findOnPath(fileName) {
  for (const rawDirectory of (process.env.PATH ?? '').split(path.delimiter)) {
    const directory = rawDirectory.trim().replace(/^"|"$/g, '');
    if (!directory) continue;
    const candidate = path.join(directory, fileName);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function resolvePowerShellExecutable() {
  const windowsRoot = process.env.WINDIR ?? String.raw`C:\Windows`;
  const programFiles = process.env.ProgramFiles ?? String.raw`C:\Program Files`;
  const candidates = [
    findOnPath('pwsh.exe'),
    path.join(programFiles, 'PowerShell', '7', 'pwsh.exe'),
    findOnPath('powershell.exe'),
    path.join(windowsRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  ];
  const executable = candidates.find(candidate => candidate && fs.existsSync(candidate));
  assert.ok(executable, 'PowerShell 7 or Windows PowerShell 5.1 must be available.');
  return executable;
}

function resolveWindowsPowerShellExecutable() {
  const windowsRoot = process.env.WINDIR ?? String.raw`C:\Windows`;
  const executable = path.join(
    windowsRoot,
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  assert.ok(fs.existsSync(executable), 'Windows PowerShell 5.1 must be available.');
  return executable;
}

function cleanPowerShellEnvironment() {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (/^(PSModulePath|PSExecutionPolicyPreference)$/i.test(key)) {
      delete environment[key];
    }
  }
  return environment;
}

function initializeCache({ server, host, cache, version }) {
  const command = [
    `$ErrorActionPreference = 'Stop'`,
    `. ${psLiteral(helperPath)}`,
    `$result = Initialize-CodexRuntimeCache -BundledServerExecutable ${psLiteral(server)} -BundledCodeModeHostExecutable ${psLiteral(host)} -CacheRoot ${psLiteral(cache)} -PackageVersion ${psLiteral(version)}`,
    `$result | ConvertTo-Json -Compress`,
  ].join('\n');
  return JSON.parse(execFileSync(resolvePowerShellExecutable(), [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    command,
  ], { encoding: 'utf8', env: cleanPowerShellEnvironment() }));
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

test('SHA-256 helper does not depend on PowerShell module auto-loading', (context) => {
  if (process.platform !== 'win32') {
    context.skip('The shared launcher is Windows-only.');
    return;
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-runtime-hash-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const fixture = path.join(directory, 'fixture.bin');
  fs.writeFileSync(fixture, 'module-independent-hash');
  const command = [
    `$ErrorActionPreference = 'Stop'`,
    `. ${psLiteral(helperPath)}`,
    `Get-CodexFileSha256 -Path ${psLiteral(fixture)}`,
  ].join('\n');
  const environment = {
    ...process.env,
    PSModulePath: path.join(directory, 'missing-modules'),
  };
  const output = execFileSync(resolveWindowsPowerShellExecutable(), [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    command,
  ], { encoding: 'utf8', env: environment }).trim();
  assert.equal(output, sha256('module-independent-hash'));
  assert.doesNotMatch(fs.readFileSync(helperPath, 'utf8'), /Get-FileHash/);
});
