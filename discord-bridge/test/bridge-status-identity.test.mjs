import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('Bridge status rejects recycled PIDs and accepts only its matching Node generation', context => {
  if (process.platform !== 'win32') { context.skip('Windows process identity.'); return; }
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const source = fs.readFileSync(path.join(root, 'Get-DiscordBridgeStatus.ps1'), 'utf8');
  const begin = source.indexOf('function Test-BridgeProcessIdentity {');
  const end = source.indexOf('\n$runtime = $null', begin);
  assert.ok(begin >= 0 && end > begin);
  const script = `
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
${source.slice(begin, end)}
$bridgeRoot = 'C:\\fixture\\discord-bridge'
$started = [datetime]'2026-10-06T21:00:00Z'
$runtime = [pscustomobject]@{pid=14040;bridgeRoot=$bridgeRoot;startedAt='2026-10-06T21:00:01Z'}
$runtimeDate = [pscustomobject]@{pid=14040;bridgeRoot=$bridgeRoot;startedAt=[datetime]::SpecifyKind([datetime]'2026-10-06T21:00:01', [DateTimeKind]::Utc)}
$node = [pscustomobject]@{Id=14040;ProcessName='node';StartTime=$started}
$foreign = [pscustomobject]@{Id=14040;ProcessName='CrossDeviceResume';StartTime=$started}
$recycledNode = [pscustomobject]@{Id=14040;ProcessName='node';StartTime=$started.AddMinutes(10)}
$wrongRoot = [pscustomobject]@{pid=14040;bridgeRoot='C:\\other';startedAt=$runtime.startedAt}
$wrongPid = [pscustomobject]@{pid=14041;bridgeRoot=$bridgeRoot;startedAt=$runtime.startedAt}
$missingDate = [pscustomobject]@{pid=14040;bridgeRoot=$bridgeRoot}
[ordered]@{
  matching=(Test-BridgeProcessIdentity $node $runtime 14040 $bridgeRoot)
  parsedDate=(Test-BridgeProcessIdentity $node $runtimeDate 14040 $bridgeRoot)
  foreign=(Test-BridgeProcessIdentity $foreign $runtime 14040 $bridgeRoot)
  recycledNode=(Test-BridgeProcessIdentity $recycledNode $runtime 14040 $bridgeRoot)
  wrongRoot=(Test-BridgeProcessIdentity $node $wrongRoot 14040 $bridgeRoot)
  wrongPid=(Test-BridgeProcessIdentity $node $wrongPid 14040 $bridgeRoot)
  missingDate=(Test-BridgeProcessIdentity $node $missingDate 14040 $bridgeRoot)
  absent=(Test-BridgeProcessIdentity $null $runtime 14040 $bridgeRoot)
} | ConvertTo-Json -Compress
`;
  const shell = path.join(process.env.WINDIR ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const output = execFileSync(shell, ['-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', timeout: 10000 });
  assert.deepEqual(JSON.parse(output.trim()), {
    matching: true, parsedDate: true, foreign: false, recycledNode: false, wrongRoot: false,
    wrongPid: false, missingDate: false, absent: false,
  });
  assert.match(source, /\$processAlive = Test-BridgeProcessIdentity/);
});
