import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const launcherRoot = path.dirname(fileURLToPath(import.meta.url));

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

function quotePowerShell(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

test('Desktop bootstrap stdio helper does not abort a subsequently successful shared connection', context => {
  if (process.platform !== 'win32') { context.skip('Windows PowerShell is required.'); return; }
  const script = `
$ErrorActionPreference = 'Stop'
. ${quotePowerShell(path.join(launcherRoot, 'CodexDesktopStartup.ps1'))}
$script:checks = 0
$script:created = [DateTimeOffset]::Now.AddSeconds(-1)
function Assert-LauncherNotCancelled { }
function Test-DesktopWebSocketConnection { $script:checks += 1; return $true }
function Get-CodexDesktopRootProcesses { [pscustomobject]@{ ProcessId = 101; CreationDate = $script:created } }
function Read-CodexDesktopStartupProgress {
  param($DesktopRoots, $Offsets, $PackageInfo, $SharedHandshakeByDesktop)
  if ($script:checks -ge 2) { $SharedHandshakeByDesktop["101|$($script:created.UtcDateTime.Ticks)"] = 'local-connected' }
  return 0
}
function Get-DesktopLocalAppServers { [pscustomobject]@{ ProcessId = 202 } }
function Write-LauncherLog { }
. ${quotePowerShell(path.join(launcherRoot, 'CodexDesktopConnection.ps1'))}
$ok = Wait-DesktopSharedConnection -PackageInfo ([pscustomobject]@{DesktopExecutable='fixture'}) -PortNumber 8798 -OwnedServerProcessId $PID -TimeoutSeconds 15 -PollMilliseconds 1
[pscustomobject]@{ok=$ok;checks=$script:checks} | ConvertTo-Json -Compress
`;
  const output = execFileSync(windowsPowerShell(), ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodedPowerShell(script)], { encoding: 'utf8' });
  assert.deepEqual(JSON.parse(output.trim()), { ok: true, checks: 3 });
});

test('Desktop connection wait remains cancellable before a shared connection exists', context => {
  if (process.platform !== 'win32') { context.skip('Windows PowerShell is required.'); return; }
  const script = `
$ErrorActionPreference = 'Stop'
. ${quotePowerShell(path.join(launcherRoot, 'CodexDesktopStartup.ps1'))}
$script:checks = 0
function Assert-LauncherNotCancelled { if ($script:checks -ge 1) { throw [OperationCanceledException]::new('fixture cancellation') } }
function Test-DesktopWebSocketConnection { $script:checks += 1; return $false }
function Get-CodexDesktopRootProcesses { [pscustomobject]@{ ProcessId = 101; CreationDate = [DateTimeOffset]::Now } }
function Read-CodexDesktopStartupProgress { return 0 }
function Get-DesktopLocalAppServers { }
function Write-LauncherLog { }
. ${quotePowerShell(path.join(launcherRoot, 'CodexDesktopConnection.ps1'))}
try {
  $null = Wait-DesktopSharedConnection -PackageInfo ([pscustomobject]@{DesktopExecutable='fixture'}) -PortNumber 8798 -OwnedServerProcessId $PID -TimeoutSeconds 10 -PollMilliseconds 1
  throw 'Cancellation was ignored.'
} catch [OperationCanceledException] {
  [pscustomobject]@{cancelled=$true} | ConvertTo-Json -Compress
}
`;
  const output = execFileSync(windowsPowerShell(), ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodedPowerShell(script)], { encoding: 'utf8' });
  assert.equal(JSON.parse(output.trim()).cancelled, true);
});

test('connected Desktop startup records browser compatibility independently of package version', context => {
  if (process.platform !== 'win32') { context.skip('Windows PowerShell is required.'); return; }
  const shells = [windowsPowerShell(), path.join(
    process.env.USERPROFILE, '.cache/codex-runtimes/codex-primary-runtime/dependencies/native/powershell/pwsh.exe',
  )].filter(shell => fs.existsSync(shell));
  for (const shell of shells) {
    const script = `
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. ${quotePowerShell(path.join(launcherRoot, 'CodexDesktopStartup.ps1'))}
. ${quotePowerShell(path.join(launcherRoot, 'CodexDesktopConnection.ps1'))}
$factory = (Get-Command New-CodexDesktopStartInfo).ScriptBlock
$script:DesktopConnectionStallSeconds = 0
function Set-RuntimeStateValue { param($State, $Name, $Value) $State[$Name] = $Value }
function Write-RuntimeState { }
function Write-LauncherProgress { }
function Write-LauncherLog { }
function Invoke-DesktopProjectSync { }
function Assert-LauncherNotCancelled { }
function Set-UserWebSocketEnvironment { }
function Get-CodexDesktopRootProcesses { [pscustomobject]@{ProcessId=101} }
function Get-CodexDesktopProcessIds { 101 }
function Wait-DesktopSharedConnection { $true }
function New-CodexDesktopStartInfo { $script:fixtureStartInfo }
$results = @(foreach ($version in @('99.1.2.3', '26.1103.4239.0')) {
    $script:fixtureStartInfo = & $factory -DesktopExecutable ${quotePowerShell(windowsPowerShell())} -WebSocketUrl 'ws://127.0.0.1:8798'
    $script:fixtureStartInfo.Arguments = '-NoProfile -NonInteractive -Command "exit 0"'
    $script:fixtureStartInfo.CreateNoWindow = $true
    $state = @{websocketUrl='ws://127.0.0.1:8798';serverProcessId=$PID}
    $package = [pscustomobject]@{DesktopExecutable=${quotePowerShell(windowsPowerShell())};ApplicationUserModelId='fixture';Version=$version}
    $result = Start-DesktopOnRuntime -PackageInfo $package -RuntimeState $state -PortNumber 8798
    @{connected=$result.RuntimeState.desktopConnectionVerified;compatibility=$result.RuntimeState.desktopBrowserAccessCompatibility;desktopIds=@($result.DesktopProcessIds)}
})
ConvertTo-Json -InputObject $results -Depth 4 -Compress
`;
    const output = execFileSync(shell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodedPowerShell(script)], { encoding: 'utf8' });
    assert.deepEqual(JSON.parse(output.trim()), [
      { connected: true, compatibility: true, desktopIds: [101] },
      { connected: true, compatibility: true, desktopIds: [101] },
    ], shell);
  }
});
