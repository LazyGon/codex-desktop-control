import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const launcherRoot = path.dirname(fileURLToPath(import.meta.url));
const helperPath = path.join(launcherRoot, 'CodexAppToolsSharedConfig.ps1');
const startPath = path.join(launcherRoot, 'Start-CodexShared.ps1');

function psLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function windowsPowerShell() {
  return path.join(
    process.env.WINDIR ?? String.raw`C:\Windows`,
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
}

function encodedPowerShell(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

function extractPowerShellFunction(source, name, nextName) {
  const start = source.indexOf(`function ${name} {`);
  const end = source.indexOf(`function ${nextName} {`, start + 1);
  assert.ok(start >= 0 && end > start, `Unable to extract ${name}.`);
  return source.slice(start, end).trim();
}

function runInstaller(configPath) {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    `. ${psLiteral(helperPath)}`,
    `$result = Install-CodexAppToolsSharedConfig -LauncherRoot ${psLiteral(launcherRoot)} -ConfigPath ${psLiteral(configPath)}`,
    '$result | ConvertTo-Json -Depth 6 -Compress',
  ].join('\n');
  return JSON.parse(execFileSync(windowsPowerShell(), [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-EncodedCommand',
    encodedPowerShell(script),
  ], { encoding: 'utf8' }).replace(/^\uFEFF/, ''));
}

function runDefinition() {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `. ${psLiteral(helperPath)}`,
    `$result = Get-CodexAppToolsSharedDefinition -LauncherRoot ${psLiteral(launcherRoot)}`,
    '$result | ConvertTo-Json -Depth 6 -Compress',
  ].join('\n');
  return JSON.parse(execFileSync(windowsPowerShell(), [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-EncodedCommand',
    encodedPowerShell(script),
  ], { encoding: 'utf8' }).replace(/^\uFEFF/, ''));
}

test('Windows PowerShell 5.1 atomically installs one stable managed transport', {
  skip: process.platform !== 'win32',
}, (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-app-tools-config-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, 'config.toml');
  const original = 'model = "gpt-5.6"\r\n\r\n[features]\r\ncode_mode = true\r\n';
  fs.writeFileSync(configPath, original, 'utf8');

  const first = runInstaller(configPath);
  assert.equal(first.Changed, true);
  assert.ok(fs.existsSync(first.BackupPath));
  assert.equal(fs.readFileSync(first.BackupPath, 'utf8'), original);
  const installed = fs.readFileSync(configPath, 'utf8');
  assert.match(installed, /^# BEGIN CODEX DESKTOP CONTROL: shared codex_app transport\r?\n/);
  assert.match(installed, /mcp_servers\.codex_app = \{ command = ".*node\.exe"/i);
  assert.match(installed, /codex-app-tools-bridge\.mjs/);
  assert.match(installed, /omit_tools_from = \["deferred", "code_mode"\]/);
  assert.ok(installed.endsWith(original));

  const second = runInstaller(configPath);
  assert.equal(second.Changed, false);
  assert.equal(second.BackupPath, null);
  assert.equal(fs.readFileSync(configPath, 'utf8'), installed);
  assert.equal((installed.match(/mcp_servers\.codex_app =/g) ?? []).length, 1);
});

test('managed transport refuses an unmanaged codex_app definition', {
  skip: process.platform !== 'win32',
}, (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-app-tools-conflict-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, 'config.toml');
  const original = '[mcp_servers.codex_app]\ncommand = "custom.exe"\n';
  fs.writeFileSync(configPath, original, 'utf8');

  assert.throws(() => runInstaller(configPath), /Command failed/);
  assert.equal(fs.readFileSync(configPath, 'utf8'), original);
  assert.deepEqual(fs.readdirSync(directory), ['config.toml']);
});

test('shared launcher repairs config before reuse and also pins the server override', () => {
  const source = fs.readFileSync(startPath, 'utf8');
  const installIndex = source.indexOf('$configInstall = Install-CodexAppToolsSharedConfig');
  const desktopIndex = source.indexOf('$existingDesktopRoots = @(');
  const serverIndex = source.indexOf('$serverProcess = Start-Process @serverStartParameters');
  assert.ok(installIndex >= 0, 'The launcher must ensure the stable user-level transport.');
  assert.ok(desktopIndex > installIndex, 'Config repair must run even when Desktop is already open.');
  assert.ok(serverIndex > desktopIndex);
  assert.match(source, /\$codexAppToolsDefinition\.Override/);
  assert.match(source, /codexAppToolsTransportSchemaVersion/);
  assert.match(source, /ConvertTo-WindowsCommandLineArgument/);
  assert.match(source, /ArgumentList = \(@\(/);
});

test('current Codex accepts a new-thread enabled_tools override over the pinned transport', {
  skip: process.platform !== 'win32',
}, (context) => {
  const statePath = path.join(launcherRoot, 'state', 'current.json');
  if (!fs.existsSync(statePath)) {
    context.skip('No installed shared runtime state is available.');
    return;
  }
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8').replace(/^\uFEFF/, ''));
  if (!fs.existsSync(state.serverExecutable)) {
    context.skip('The recorded Codex executable is unavailable.');
    return;
  }
  const temporaryHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-new-thread-config-'));
  context.after(() => fs.rmSync(temporaryHome, { recursive: true, force: true }));
  const definition = runDefinition();
  const output = execFileSync(state.serverExecutable, [
    '-c', definition.Override,
    '-c', 'mcp_servers.codex_app.enabled_tools=[]',
    'mcp', 'list',
  ], {
    encoding: 'utf8',
    env: { ...process.env, CODEX_HOME: temporaryHome },
  });
  assert.match(output, /codex_app/);
  assert.match(output, /codex-app-tools-bridge\.mjs/);
});

test('Windows PowerShell 5.1 preserves the complete TOML override as one argv value', {
  skip: process.platform !== 'win32',
}, (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex argv quote '));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const fixturePath = path.join(directory, 'print argv.mjs');
  const outputPath = path.join(directory, 'argv.json');
  fs.writeFileSync(fixturePath, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n');
  const source = fs.readFileSync(startPath, 'utf8');
  const quoteFunction = extractPowerShellFunction(
    source,
    'ConvertTo-WindowsCommandLineArgument',
    'Wait-AppServerReady',
  );
  const override = runDefinition().Override;
  const script = [
    "$ErrorActionPreference = 'Stop'",
    quoteFunction,
    `$arguments = @(${psLiteral(fixturePath)}, ${psLiteral(override)})`,
    "$argumentLine = (@($arguments | ForEach-Object { ConvertTo-WindowsCommandLineArgument -Value ([string]$_) }) -join ' ')",
    `Start-Process -FilePath ${psLiteral(process.execPath)} -ArgumentList $argumentLine -Wait -NoNewWindow -RedirectStandardOutput ${psLiteral(outputPath)}`,
  ].join('\n');
  execFileSync(windowsPowerShell(), [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodedPowerShell(script),
  ], { encoding: 'utf8' });
  assert.deepEqual(JSON.parse(fs.readFileSync(outputPath, 'utf8').replace(/^\uFEFF/, '')), [override]);
});
