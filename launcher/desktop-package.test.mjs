import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const launcherRoot = path.dirname(fileURLToPath(import.meta.url));
const helperPath = path.join(launcherRoot, 'CodexDesktopPackage.ps1');

function psLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
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

function makePackage(root, version, { runtime = false } = {}) {
  const installLocation = path.join(root, `OpenAI.Codex_${version}`);
  const appDirectory = path.join(installLocation, 'app');
  const resourceDirectory = path.join(appDirectory, 'resources');
  fs.mkdirSync(resourceDirectory, { recursive: true });
  fs.writeFileSync(path.join(appDirectory, 'ChatGPT.exe'), `desktop-${version}`);
  if (runtime) {
    fs.writeFileSync(path.join(resourceDirectory, 'codex.exe'), `server-${version}`);
    fs.writeFileSync(path.join(resourceDirectory, 'codex-code-mode-host.exe'), `host-${version}`);
  }
  return { version, installLocation };
}

function packageExpression(packages) {
  return `@(${packages.map(item => [
    '[pscustomobject]@{',
    `Version = [version]${psLiteral(item.version)};`,
    `InstallLocation = ${psLiteral(item.installLocation)};`,
    `PackageFamilyName = 'OpenAI.Codex_2p2nqsd0c76g0'`,
    '}',
  ].join(' ')).join(',')})`;
}

function runPowerShell(command) {
  return execFileSync(resolvePowerShellExecutable(), [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `$ErrorActionPreference = 'Stop'; . ${psLiteral(helperPath)}; ${command}`,
  ], { encoding: 'utf8' }).trim();
}

test('Desktop package resolution follows the newest OpenAI.Codex version and validates its runtime', (context) => {
  if (process.platform !== 'win32') {
    context.skip('The Desktop package resolver is Windows-only.');
    return;
  }

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-desktop-package-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const oldPackage = makePackage(directory, '26.803.10989.0');
  const newPackage = makePackage(directory, '26.818.2441.0', { runtime: true });
  const packages = packageExpression([oldPackage, newPackage]);

  const output = runPowerShell(
    `$result = Get-CodexDesktopPackageInfo -Packages ${packages} -RequireBundledRuntime; $result | ConvertTo-Json -Compress`,
  );
  const result = JSON.parse(output);

  assert.equal(result.Version, newPackage.version);
  assert.equal(result.DesktopExecutable, path.join(newPackage.installLocation, 'app', 'ChatGPT.exe'));
  assert.equal(result.BundledServerExecutable, path.join(newPackage.installLocation, 'app', 'resources', 'codex.exe'));
  assert.equal(result.ApplicationUserModelId, 'OpenAI.Codex_2p2nqsd0c76g0!App');
});

test('Desktop package replacement is emitted once the installed version or executable changes', (context) => {
  if (process.platform !== 'win32') {
    context.skip('The Desktop package resolver is Windows-only.');
    return;
  }

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-desktop-replacement-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const oldPackage = makePackage(directory, '26.803.10989.0');
  const newPackage = makePackage(directory, '26.818.2441.0');
  const packages = packageExpression([oldPackage, newPackage]);

  const replacementOutput = runPowerShell([
    `$result = Get-CodexDesktopPackageReplacement -CurrentVersion ${psLiteral(oldPackage.version)}`,
    `-CurrentDesktopExecutable ${psLiteral(path.join(oldPackage.installLocation, 'app', 'ChatGPT.exe'))}`,
    `-Packages ${packages};`,
    '$result | ConvertTo-Json -Compress',
  ].join(' '));
  assert.equal(JSON.parse(replacementOutput).Version, newPackage.version);

  const unchangedOutput = runPowerShell([
    `$result = Get-CodexDesktopPackageReplacement -CurrentVersion ${psLiteral(newPackage.version)}`,
    `-CurrentDesktopExecutable ${psLiteral(path.join(newPackage.installLocation, 'app', 'ChatGPT.exe'))}`,
    `-Packages ${packages};`,
    "if ($null -eq $result) { 'UNCHANGED' } else { 'REPLACED' }",
  ].join(' '));
  assert.equal(unchangedOutput, 'UNCHANGED');
});
