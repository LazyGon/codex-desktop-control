import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const launcherRoot = path.dirname(fileURLToPath(import.meta.url));
const helper = path.join(launcherRoot, 'CodexProcessEnvironment.ps1');
const startScript = path.join(launcherRoot, 'Start-CodexShared.ps1');

function psLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function runPowerShell(script) {
  return execFileSync('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    script,
  ], { encoding: 'utf8' }).trim();
}

test('shared launcher prepends an installed CLI redirect for child processes', context => {
  if (process.platform !== 'win32') {
    context.skip('The shared launcher is Windows-only.');
    return;
  }

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-process-environment-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const installRoot = path.join(directory, 'bin');
  fs.mkdirSync(installRoot);
  for (const name of ['codex.cmd', 'codex.ps1', 'redirect.json']) {
    fs.writeFileSync(path.join(installRoot, name), '', 'utf8');
  }

  const oldOne = path.join(directory, 'old-one');
  const oldTwo = path.join(directory, 'old-two');
  const payload = JSON.parse(runPowerShell([
    `. ${psLiteral(helper)}`,
    `$env:Path = ${psLiteral(`${oldOne};${installRoot}\\;${oldTwo};${installRoot}`)}`,
    `$enabled = Enable-CodexCliRedirectForChildProcesses -InstallRoot ${psLiteral(installRoot)}`,
    `[ordered]@{ Enabled = $enabled; Path = $env:Path } | ConvertTo-Json -Compress`,
  ].join('; ')));

  assert.equal(payload.Enabled, true);
  const entries = payload.Path.split(';');
  assert.equal(entries[0], installRoot);
  assert.deepEqual(entries.slice(1), [oldOne, oldTwo]);
});

test('shared launcher leaves PATH unchanged when the CLI redirect is not installed', context => {
  if (process.platform !== 'win32') {
    context.skip('The shared launcher is Windows-only.');
    return;
  }

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-process-environment-missing-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const originalPath = path.join(directory, 'original');
  const payload = JSON.parse(runPowerShell([
    `. ${psLiteral(helper)}`,
    `$env:Path = ${psLiteral(originalPath)}`,
    `$enabled = Enable-CodexCliRedirectForChildProcesses -InstallRoot ${psLiteral(path.join(directory, 'missing'))}`,
    `[ordered]@{ Enabled = $enabled; Path = $env:Path } | ConvertTo-Json -Compress`,
  ].join('; ')));

  assert.equal(payload.Enabled, false);
  assert.equal(payload.Path, originalPath);
});

test('shared launcher enables the redirect before starting app-server', () => {
  const source = fs.readFileSync(startScript, 'utf8');
  const enableIndex = source.indexOf(
    '$cliRedirectEnabledForChildProcesses = Enable-CodexCliRedirectForChildProcesses',
  );
  const startIndex = source.indexOf('$serverProcess = Start-Process @serverStartParameters');
  assert.ok(enableIndex >= 0, 'The launcher must enable the redirect in its process PATH.');
  assert.ok(startIndex > enableIndex, 'The redirect must be enabled before app-server starts.');
});
