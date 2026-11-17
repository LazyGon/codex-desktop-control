import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const launcher = path.dirname(fileURLToPath(import.meta.url));
const quote = value => `'${String(value).replaceAll("'", "''")}'`;
const powershell = path.join(process.env.WINDIR ?? 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');

function run(script) {
  const prefix = `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; Set-StrictMode -Version Latest;
. ${quote(path.join(launcher, 'CodexDesktopStartup.ps1'))}
. ${quote(path.join(launcher, 'CodexDesktopConnection.ps1'))}
`;
  return JSON.parse(execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(prefix + script, 'utf16le').toString('base64')], { encoding: 'utf8' }));
}

const fixture = `
$script:created = [DateTimeOffset]'2026-11-17T03:15:54Z'
$script:desktop = [pscustomobject]@{ProcessId=101;CreationDate=$script:created}
$package = [pscustomobject]@{DesktopExecutable='fixture';PackageFamilyName='fixture'}
$script:runtime = $null
$script:socket = $false
$script:phases = @()
function Get-CodexDesktopRootProcesses { $script:desktop }
function Get-ReusableRuntimeState { $script:runtime }
function Test-DesktopWebSocketConnection { $script:socket }
function Write-LauncherLog { }
function Write-LauncherProgress { param($Phase) $script:phases += $Phase }
function Get-Process { throw 'An existing Desktop must not be closed for endpoint recovery.' }
`;

test('server-only startup proceeds while an unrelated Desktop remains open', context => {
  if (process.platform !== 'win32') { context.skip('Windows PowerShell required.'); return; }
  const result = run(fixture + `
function Get-ReusableRuntimeState { throw 'Desktop connection inspection is not required for server-only startup.' }
$result=Resolve-ExistingDesktopStartup -PackageInfo $package -PortNumber 8798 -ServerOnly
@{handled=$result.Handled;reconnect=@($result.ReconnectRoots).Count;phases=$script:phases}|ConvertTo-Json -Compress
`);
  assert.deepEqual(result, { handled: false, reconnect: 0, phases: [] });
});

test('only the same live Desktop requesting the exact shared endpoint is reused after connection refusal', context => {
  if (process.platform !== 'win32') { context.skip('Windows PowerShell required.'); return; }
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-desktop-reconnect-'));
  context.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const directory = path.join(temporary, 'Codex/Logs/2026/11/17');
  fs.mkdirSync(directory, { recursive: true });
  const log = path.join(directory, 'codex-desktop-fixture-101-t0-0.log');
  const refused = (endpoint, fields = 'hostKind=local') =>
    `2026-11-17T03:16:02Z error [AppServerConnection] app_server_connection.websocket_error connectionId=1 errorCode=ECONNREFUSED ${fields} message="connect ECONNREFUSED ${endpoint}" transport=websocket\n`;
  const cases = [
    { content: refused('127.0.0.1:8798'), handled: false, roots: [101] },
    { content: refused('127.0.0.1:87980'), handled: true, roots: [] },
    { content: refused('127.0.0.1:9000'), handled: true, roots: [] },
    { content: refused('192.168.1.2:8798'), handled: true, roots: [] },
    { content: refused('127.0.0.1:8798', 'hostId=remote'), handled: true, roots: [] },
    { content: refused('127.0.0.1:8798').replace('03:16:02', '03:15:00'), handled: true, roots: [] },
    { content: refused('127.0.0.1:8798') + '2026-11-17T03:16:03Z info [AppServerConnection] Starting app-server connection hostId=local transport=stdio\n', handled: true, roots: [] },
    { content: refused('127.0.0.1:8798') + refused('127.0.0.1:9000').replace('03:16:02', '03:16:03'), handled: true, roots: [] },
    { content: refused('127.0.0.1:8798') + refused('127.0.0.1:9000').replace('03:16:02', '03:16:01'), handled: false, roots: [101] },
    { content: '2026-11-17T03:16:02Z info [AppServerConnection] Starting app-server connection hostId=local transport=stdio\n', handled: true, roots: [] },
    { content: refused('127.0.0.1:8798'), processId: 202, handled: true, roots: [] },
  ];
  for (const entry of cases) {
    fs.writeFileSync(log, entry.content);
    const result = run(fixture + `
$env:LOCALAPPDATA=${quote(temporary)}
$script:desktop.ProcessId=${entry.processId ?? 101}
$result=Resolve-ExistingDesktopStartup -PackageInfo $package -PortNumber 8798
@{handled=$result.Handled;roots=@($result.ReconnectRoots|ForEach-Object ProcessId)}|ConvertTo-Json -Compress
`);
    assert.deepEqual(result, { handled: entry.handled, roots: entry.roots }, entry.content);
  }
  fs.writeFileSync(log, refused('127.0.0.1:8798'));
  const retry = run(fixture + `
$env:LOCALAPPDATA=${quote(temporary)}
$result=Resolve-ExistingDesktopStartup -PackageInfo $package -PortNumber 8798 -RetryDesktop
@{handled=$result.Handled;roots=@($result.ReconnectRoots|ForEach-Object ProcessId)}|ConvertTo-Json -Compress
`);
  assert.deepEqual(retry, { handled: false, roots: [101] });
});

test('a connected Desktop is registered after a server-only launch; a recorded owner is only observed', context => {
  if (process.platform !== 'win32') { context.skip('Windows PowerShell required.'); return; }
  const result = run(fixture + `
$script:socket=$true
$script:runtime=@{desktopConnectionVerified=$false;desktopProcessIds=@()}
$adopt=Resolve-ExistingDesktopStartup -PackageInfo $package -PortNumber 8798
$script:runtime=@{desktopConnectionVerified=$true;desktopProcessIds=@(101)}
$observe=Resolve-ExistingDesktopStartup -PackageInfo $package -PortNumber 8798
@{adopt=@{handled=$adopt.Handled;roots=@($adopt.ReconnectRoots|ForEach-Object ProcessId)};observe=@{handled=$observe.Handled;roots=@($observe.ReconnectRoots).Count}}|ConvertTo-Json -Depth 5 -Compress
`);
  assert.deepEqual(result, { adopt: { handled: false, roots: [101] }, observe: { handled: true, roots: 0 } });
});

const reconnectFixture = fixture + `
$script:DesktopConnectionStallSeconds=0
$script:launchedDesktopRoots=@()
$script:writes=0
function Set-RuntimeStateValue { param($State,$Name,$Value) $State[$Name]=$Value }
function Write-RuntimeState { $script:writes+=1 }
function Get-CodexDesktopProcessIds { 101 }
function Wait-DesktopSharedConnection { $true }
function Show-LauncherMessage { }
function Invoke-DesktopProjectSync { throw 'Do not rewrite the open Desktop global state.' }
function New-CodexDesktopStartInfo { throw 'Do not launch another Desktop.' }
function Set-UserWebSocketEnvironment { throw 'Do not change the existing Desktop launch environment.' }
$state=@{websocketUrl='ws://127.0.0.1:8798';serverProcessId=999}
`;

test('reconnection keeps the existing Desktop and records completion without another launch or cache rewrite', context => {
  if (process.platform !== 'win32') { context.skip('Windows PowerShell required.'); return; }
  const result = run(reconnectFixture + `
$result=Start-DesktopOnRuntime -PackageInfo $package -RuntimeState $state -PortNumber 8798 -ExistingDesktopRoots @($script:desktop)
@{verified=$state.desktopConnectionVerified;mode=$state.mode;ids=@($state.desktopProcessIds);launched=@($script:launchedDesktopRoots).Count;browserCompatibility=$state.desktopBrowserAccessCompatibility}|ConvertTo-Json -Compress
`);
  assert.deepEqual(result, { verified: true, mode: 'desktop', ids: [101], launched: 0, browserCompatibility: false });
});

test('a changed Desktop identity is rejected before publishing runtime state or launching anything', context => {
  if (process.platform !== 'win32') { context.skip('Windows PowerShell required.'); return; }
  const result = run(reconnectFixture + `
$expected=[pscustomobject]@{ProcessId=101;CreationDate=$script:created.AddMinutes(-1)}
try { $null=Start-DesktopOnRuntime -PackageInfo $package -RuntimeState $state -PortNumber 8798 -ExistingDesktopRoots @($expected); $rejected=$false } catch { $rejected=$true }
@{rejected=$rejected;writes=$script:writes;state=$state}|ConvertTo-Json -Compress
`);
  assert.deepEqual(result, { rejected: true, writes: 0,
    state: { websocketUrl: 'ws://127.0.0.1:8798', serverProcessId: 999 } });
});

test('a former handshake cannot mark a disconnected Desktop ready while it reconnects', context => {
  if (process.platform !== 'win32') { context.skip('Windows PowerShell required.'); return; }
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-desktop-handshake-reset-'));
  context.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const directory = path.join(temporary, 'Codex/Logs/2026/11/17');
  fs.mkdirSync(directory, { recursive: true });
  const log = path.join(directory, 'codex-desktop-fixture-101-t0-0.log');
  const handshake = '2026-11-17T03:16:01Z info [AppServerConnection] initialize_handshake_result outcome=success hostId=local transportKind=websocket\n';
  const connected = '2026-11-17T03:16:01Z info [AppServerConnection] app_server_connection.state_changed hostId=local initialized=true next=connected pendingClientRequests=0\n';
  fs.writeFileSync(log, handshake + connected + '2026-11-17T03:16:02Z info [AppServerConnection] Starting app-server connection hostId=local transport=websocket\n');
  const result = run(fixture + `
$env:LOCALAPPDATA=${quote(temporary)}
$states=@{}; $offsets=@{}; $roots=@($script:desktop)
$null=Read-CodexDesktopStartupProgress $roots $offsets $package -SharedHandshakeByDesktop $states
$before=$states.Values -contains 'local-connected'
[IO.File]::AppendAllText(${quote(log)},${quote(handshake)})
$null=Read-CodexDesktopStartupProgress $roots $offsets $package -SharedHandshakeByDesktop $states
$handshakeOnly=$states.Values -contains 'local-connected'
[IO.File]::AppendAllText(${quote(log)},${quote(connected)})
$null=Read-CodexDesktopStartupProgress $roots $offsets $package -SharedHandshakeByDesktop $states
@($before,$handshakeOnly,($states.Values -contains 'local-connected'))|ConvertTo-Json -Compress
`);
  assert.deepEqual(result, [false, false, true]);
});
