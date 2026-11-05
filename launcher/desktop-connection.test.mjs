import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
function Assert-LauncherNotCancelled { }
function Test-DesktopWebSocketConnection { $script:checks += 1; return ($script:checks -ge 3) }
function Get-CodexDesktopRootProcesses { [pscustomobject]@{ ProcessId = 101 } }
function Read-CodexDesktopStartupProgress { return 0 }
function Get-DesktopLocalAppServers { [pscustomobject]@{ ProcessId = 202 } }
function Write-LauncherLog { }
. ${quotePowerShell(path.join(launcherRoot, 'CodexDesktopConnection.ps1'))}
$ok = Wait-DesktopSharedConnection -PackageInfo ([pscustomobject]@{DesktopExecutable='fixture'}) -PortNumber 8798 -OwnedServerProcessId $PID -TimeoutSeconds 15 -PollMilliseconds 1
[pscustomobject]@{ok=$ok} | ConvertTo-Json -Compress
`;
  const output = execFileSync(windowsPowerShell(), ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodedPowerShell(script)], { encoding: 'utf8' });
  assert.equal(JSON.parse(output.trim()).ok, true);
});

test('Desktop connection wait remains cancellable before a shared connection exists', context => {
  if (process.platform !== 'win32') { context.skip('Windows PowerShell is required.'); return; }
  const script = `
$ErrorActionPreference = 'Stop'
. ${quotePowerShell(path.join(launcherRoot, 'CodexDesktopStartup.ps1'))}
$script:checks = 0
function Assert-LauncherNotCancelled { if ($script:checks -ge 1) { throw [OperationCanceledException]::new('fixture cancellation') } }
function Test-DesktopWebSocketConnection { $script:checks += 1; return $false }
function Get-CodexDesktopRootProcesses { [pscustomobject]@{ ProcessId = 101 } }
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
