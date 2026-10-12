import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const helper = path.join(import.meta.dirname, 'CodexNodeRuntime.ps1');
const ps = path.join(process.env.WINDIR ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const quote = value => `'${value.replaceAll("'", "''")}'`;
function probe(body, env = process.env) {
  return JSON.parse(execFileSync(ps, ['-NoProfile', '-NonInteractive', '-Command', [
    "$ErrorActionPreference='Stop'",
    '[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)',
    `. ${quote(helper)}`,
    body,
  ].join('; ')], { encoding: 'utf8', env }));
}
const snapshot = `
  # GetEnvironmentVariable expands REG_EXPAND_SZ using this process's environment.
  # Compare the persisted values, not expansions that intentionally change here.
  function Get-SavedEnvironmentValue($scope, $name) {
    $key=if($scope -eq 'User') {
      [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment')
    } else {
      [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment')
    };
    try {
      if($null -eq $key) { return $null }
      $key.GetValue($name,$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    } finally {
      if($null -ne $key) { $key.Dispose() }
    }
  }
  $before=@{};
  foreach($scope in @('User','Machine')) {
    foreach($key in @('PATH','PATHEXT','ComSpec')) {
      $before["$scope/$key"]=Get-SavedEnvironmentValue $scope $key
    }
  }
`;
const unchanged = `
  $registryUnchanged=$true;
  foreach($scope in @('User','Machine')) {
    foreach($key in @('PATH','PATHEXT','ComSpec')) {
      if($before["$scope/$key"] -cne (Get-SavedEnvironmentValue $scope $key)) { $registryUnchanged=$false }
    }
  }
`;
const inheritedEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !['pathext', 'comspec'].includes(key.toLowerCase())));

test('missing Windows environment reproduces the original failure, then process-only repair permits the exact Node pipeline', () => {
  const result = probe(`${snapshot}
    $initialPathext=$env:PATHEXT;
    $initialComSpec=$env:ComSpec;
    $originalErrorId=$null;
    try { $unused=& ${quote(process.execPath)} --version | Out-String }
    catch { $originalErrorId=$_.FullyQualifiedErrorId }
    $repair=Initialize-CodexWindowsProcessEnvironment;
    $version=(& ${quote(process.execPath)} --version | Out-String).Trim();
    $nodeExitCode=$LASTEXITCODE;
    ${unchanged}
    [ordered]@{ initialPathext=$initialPathext; initialComSpec=$initialComSpec; originalErrorId=$originalErrorId; repair=$repair; version=$version; exitCode=$nodeExitCode; registryUnchanged=$registryUnchanged; savedExecutableExists=[IO.File]::Exists($env:ComSpec) } | ConvertTo-Json -Compress
  `, inheritedEnv);
  assert.match(result.originalErrorId, /CantActivateDocumentInPipeline/);
  assert.equal(result.repair.PathextChanged, true);
  assert.equal(result.repair.ComSpecChanged, true);
  assert.equal(result.version, process.version);
  assert.equal(result.exitCode, 0);
  assert.equal(result.registryUnchanged, true);
  assert.equal(result.savedExecutableExists, true);
});

test('valid explicit process values are preserved and initialization is idempotent', () => {
  const result = probe(`
    $env:PATHEXT='.exe;.CUSTOM;.CPL';
    $env:ComSpec=[Environment]::GetEnvironmentVariable('ComSpec','Machine');
    $beforeComSpec=$env:ComSpec;
    $first=Initialize-CodexWindowsProcessEnvironment;
    $second=Initialize-CodexWindowsProcessEnvironment;
    [ordered]@{ first=$first; second=$second; pathext=$env:PATHEXT; comspecUnchanged=($env:ComSpec -ceq $beforeComSpec) } | ConvertTo-Json -Compress
  `);
  for (const repair of [result.first, result.second]) {
    assert.equal(repair.PathextChanged, false);
    assert.equal(repair.ComSpecChanged, false);
  }
  assert.equal(result.pathext, '.exe;.CUSTOM;.CPL');
  assert.equal(result.comspecUnchanged, true);
});

test('an invalid ComSpec is repaired without replacing a valid restricted PATHEXT', () => {
  const result = probe(`
    $env:PATHEXT='.EXE;.CUSTOM';
    $env:ComSpec='relative-missing.exe';
    $repair=Initialize-CodexWindowsProcessEnvironment;
    $second=Initialize-CodexWindowsProcessEnvironment;
    [ordered]@{ repair=$repair; second=$second; pathext=$env:PATHEXT; comspecRooted=[IO.Path]::IsPathRooted($env:ComSpec); comspecExists=[IO.File]::Exists($env:ComSpec) } | ConvertTo-Json -Compress
  `);
  assert.equal(result.repair.PathextChanged, false);
  assert.equal(result.repair.ComSpecChanged, true);
  assert.equal(result.second.ComSpecChanged, false);
  assert.equal(result.pathext, '.EXE;.CUSTOM');
  assert.equal(result.comspecRooted, true);
  assert.equal(result.comspecExists, true);
});

test('the production runtime initializer repairs the sparse environment before invoking Node or signed PowerShell discovery', context => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-windows-bootstrap-'));
  context.after(() => fs.rmSync(stateRoot, { recursive: true, force: true }));
  fs.writeFileSync(path.join(stateRoot, 'node-runtime.json'), JSON.stringify({ schemaVersion: 1, nodeExecutable: process.execPath }));
  const result = probe(`${snapshot}
    $env:PATH=${quote(path.dirname(process.execPath))}+';'+$env:PATH;
    $node=Initialize-CodexNodeRuntime -StateRoot ${quote(stateRoot)};
    $version=(& $node --version | Out-String).Trim();
    $bundled=Get-CodexBundledPowerShellExecutable -NodeExecutable $node;
    $selectedPowerShell=if($bundled) { (Get-Command pwsh.exe -ErrorAction Stop).Source } else { $null };
    ${unchanged}
    [ordered]@{ node=$node; version=$version; executableRecognized=(($env:PATHEXT -split ';') -contains '.EXE'); comspecExists=[IO.File]::Exists($env:ComSpec); registryUnchanged=$registryUnchanged; bundledPowerShell=$bundled; selectedPowerShell=$selectedPowerShell } | ConvertTo-Json -Compress
  `, inheritedEnv);
  assert.equal(result.version, process.version);
  assert.equal(result.executableRecognized, true);
  assert.equal(result.comspecExists, true);
  assert.equal(result.registryUnchanged, true);
  if (result.bundledPowerShell) {
    assert.equal(result.selectedPowerShell.toLowerCase(), result.bundledPowerShell.toLowerCase());
  } else {
    assert.equal(result.selectedPowerShell, null);
  }
});
