import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

test('Bridge status accepts only the process generation recorded by its lock and runtime', { skip: process.platform !== 'win32' }, context => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-status-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.mkdirSync(path.join(directory, 'data'));
  fs.copyFileSync(new URL('../Get-DiscordBridgeStatus.ps1', import.meta.url),
    path.join(directory, 'Get-DiscordBridgeStatus.ps1'));

  const fixture = directory.replaceAll("'", "''");
  const command = `
$ErrorActionPreference = 'Stop'
$global:fixture = '${fixture}'
$global:fakeBridgeProcess = $null
function Get-Process {
  param($Id, $Name)
  if ($Name) { return $null }
  return $global:fakeBridgeProcess
}
function Get-ScheduledTask { return $null }
function Invoke-WebRequest { return [pscustomobject]@{ StatusCode = 200 } }
$started = [datetime]'2026-10-06T21:00:00Z'
$cases = @(
  @{ name='matching'; processName='node'; processStart=$started; runtimePid=14040; runtimeRoot=$global:fixture; runtimeStart='2026-10-06T21:00:01Z' },
  @{ name='foreign'; processName='CrossDeviceResume'; processStart=$started; runtimePid=14040; runtimeRoot=$global:fixture; runtimeStart='2026-10-06T21:00:01Z' },
  @{ name='recycled'; processName='node'; processStart=$started.AddMinutes(10); runtimePid=14040; runtimeRoot=$global:fixture; runtimeStart='2026-10-06T21:00:01Z' },
  @{ name='wrongRoot'; processName='node'; processStart=$started; runtimePid=14040; runtimeRoot='C:\\other'; runtimeStart='2026-10-06T21:00:01Z' },
  @{ name='wrongPid'; processName='node'; processStart=$started; runtimePid=14041; runtimeRoot=$global:fixture; runtimeStart='2026-10-06T21:00:01Z' },
  @{ name='missingDate'; processName='node'; processStart=$started; runtimePid=14040; runtimeRoot=$global:fixture; runtimeStart=$null }
)
$results = [ordered]@{}
foreach ($case in $cases) {
  $global:fakeBridgeProcess = [pscustomobject]@{ Id=14040; ProcessName=$case.processName; StartTime=$case.processStart }
  $runtime = @{ pid=$case.runtimePid; bridgeRoot=$case.runtimeRoot; phase='running'; discordReady=$true; discordUser='fixture-bot'; updatedAt='2026-10-06T21:00:02Z'; codex=@{ endpoint='ws://127.0.0.1:1'; connected=$true; bindings=1 } }
  if ($case.runtimeStart) { $runtime.startedAt = $case.runtimeStart }
  $runtime | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $global:fixture 'data/runtime.json')
  Set-Content -LiteralPath (Join-Path $global:fixture 'data/bridge.lock') -Value '14040'
  $status = & (Join-Path $global:fixture 'Get-DiscordBridgeStatus.ps1') -Json | ConvertFrom-Json
  $results[$case.name] = @{ alive=$status.ProcessAlive; phase=$status.Phase; ready=$status.DiscordReady }
}
$results | ConvertTo-Json -Depth 5 -Compress
`;
  const shell = path.join(process.env.WINDIR ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const output = execFileSync(shell, ['-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(command, 'utf16le').toString('base64')], { encoding: 'utf8', timeout: 30000 });
  const statuses = JSON.parse(output.trim());
  assert.deepEqual(statuses.matching, { alive: true, phase: 'running', ready: true });
  for (const name of ['foreign', 'recycled', 'wrongRoot', 'wrongPid', 'missingDate']) {
    assert.deepEqual(statuses[name], { alive: false, phase: 'stopped-unexpectedly', ready: false });
  }
});
