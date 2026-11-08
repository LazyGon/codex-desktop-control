import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const launcherRoot = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.join(launcherRoot, 'CodexSharedLauncher.cs');

function compilerPath() {
  const windowsRoot = process.env.WINDIR ?? String.raw`C:\Windows`;
  const candidates = [
    path.join(windowsRoot, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    path.join(windowsRoot, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
  ];
  return candidates.find(candidate => fs.existsSync(candidate));
}

function compile(compiler, output, sources, main = null, target = 'exe') {
  const arguments_ = [
    '/nologo',
    `/target:${target}`,
    `/out:${output}`,
    '/reference:System.Drawing.dll',
    '/reference:System.Web.Extensions.dll',
    '/reference:System.Windows.Forms.dll',
  ];
  if (main) arguments_.push(`/main:${main}`);
  arguments_.push(...sources);
  execFileSync(compiler, arguments_, { stdio: 'pipe' });
}

async function waitForFile(filePath, timeoutMs = 300_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

test('a Bridge that finishes initializing late is connected only while its own live socket and state agree', async context => {
  if (process.platform !== 'win32') { context.skip('Windows-only launcher.'); return; }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-bridge-status-'));
  const harness = path.join(directory, 'BridgeStatusHarness.cs');
  const exe = path.join(directory, 'BridgeStatusHarness.exe');
  const config = path.join(directory, 'config');
  const data = path.join(directory, 'data');
  const configFile = path.join(config, 'config.json');
  const lockFile = path.join(data, 'bridge.lock');
  const runtimeFile = path.join(data, 'runtime.json');
  context.after(() => {
    for (const file of [configFile, lockFile, runtimeFile, harness, exe]) fs.rmSync(file, { force: true });
    for (const dir of [config, data, directory]) fs.rmdirSync(dir);
  });
  fs.mkdirSync(config);
  fs.mkdirSync(data);
  fs.writeFileSync(configFile, '{}');
  fs.writeFileSync(harness, `
using System;
internal static class BridgeStatusHarness {
    static void Main(string[] args) {
        var observation = new SharedRuntimeObservation { ServerReady = true, Endpoint = args[1] };
        SharedLaunchProgressForm.ReadBridgeObservation(args[0], observation);
        Console.Write(observation.BridgeAlive + ":" + observation.BridgeReady);
    }
}`);
  compile(compilerPath(), exe, [sourcePath, harness], 'BridgeStatusHarness');

  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  context.after(() => server.close());
  const port = server.address().port;
  const socket = net.connect(port, '127.0.0.1');
  context.after(() => socket.destroy());
  await once(socket, 'connect');
  const endpoint = `ws://127.0.0.1:${port}`;
  const processStarted = Date.now() - process.uptime() * 1000;
  const delayedRecord = new Date(processStarted + 120_000).toISOString();
  const writeRuntime = startedAt => fs.writeFileSync(runtimeFile, JSON.stringify({
    phase: 'running', pid: process.pid, bridgeRoot: directory, startedAt,
    discordReady: true, codex: { connected: true, endpoint },
  }));
  const status = () => execFileSync(exe, [directory, endpoint], { encoding: 'utf8' });
  fs.writeFileSync(lockFile, String(process.pid));
  writeRuntime(delayedRecord);
  assert.equal(status(), 'True:True');

  writeRuntime(new Date(processStarted - 120_000).toISOString());
  assert.equal(status(), 'False:False', 'A stale record must not verify a newer process with the same PID.');
  writeRuntime(delayedRecord);
  fs.writeFileSync(lockFile, String(process.pid + 1));
  assert.equal(status(), 'False:False', 'A different Bridge lock must not verify the runtime record.');
  fs.writeFileSync(lockFile, String(process.pid));

  const closed = once(socket, 'close');
  socket.destroy();
  await closed;
  assert.equal(status(), 'True:False', 'A cached connected flag is insufficient without the real loopback connection.');
});

test('PowerShell resolver honors all four supported search tiers', context => {
  if (process.platform !== 'win32') {
    context.skip('The shared launcher is Windows-only.');
    return;
  }

  const compiler = compilerPath();
  assert.ok(compiler, 'The .NET Framework C# compiler must be available.');

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-shared-resolver-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const executable = path.join(directory, 'ResolverHarness.exe');
  const harness = path.join(directory, 'ResolverHarness.cs');
  fs.writeFileSync(harness, [
    'using System;',
    'using System.Collections.Generic;',
    'internal static class ResolverHarness',
    '{',
    '    private static int Main(string[] args)',
    '    {',
    '        var existing = new HashSet<string>(StringComparer.OrdinalIgnoreCase);',
    '        for (int index = 3; index < args.Length; index++) existing.Add(args[index]);',
    '        Console.Write(CodexSharedLauncher.ResolvePowerShell(',
    '            args[0], args[1], args[2], existing.Contains));',
    '        return 0;',
    '    }',
    '}',
  ].join('\r\n'), 'utf8');
  compile(compiler, executable, [sourcePath, harness], 'ResolverHarness');

  const pathPwsh = String.raw`C:\path-pwsh\pwsh.exe`;
  const standardPwsh = String.raw`C:\program-files\PowerShell\7\pwsh.exe`;
  const pathWindowsPowerShell = String.raw`C:\path-powershell\powershell.exe`;
  const standardWindowsPowerShell = String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`;
  const pathValue = String.raw`C:\path-pwsh;C:\path-powershell`;

  const resolve = existing => execFileSync(executable, [
    pathValue,
    String.raw`C:\program-files`,
    String.raw`C:\Windows\System32`,
    ...existing,
  ], { encoding: 'utf8' });

  assert.equal(resolve([
    pathPwsh,
    standardPwsh,
    pathWindowsPowerShell,
    standardWindowsPowerShell,
  ]), pathPwsh);
  assert.equal(resolve([
    standardPwsh,
    pathWindowsPowerShell,
    standardWindowsPowerShell,
  ]), standardPwsh);
  assert.equal(resolve([
    pathWindowsPowerShell,
    standardWindowsPowerShell,
  ]), pathWindowsPowerShell);
  assert.equal(resolve([standardWindowsPowerShell]), standardWindowsPowerShell);
});

test('background shared launcher uses a supported shell without injecting execution policy', async context => {
  if (process.platform !== 'win32') {
    context.skip('The shared launcher is Windows-only.');
    return;
  }

  const compiler = compilerPath();
  assert.ok(compiler, 'The .NET Framework C# compiler must be available.');

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-shared-launcher-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const executable = path.join(directory, 'CodexSharedLauncher.exe');
  const output = path.join(directory, 'shell.json');
  const fixtureScript = path.join(directory, 'Start-CodexShared.ps1');

  fs.writeFileSync(fixtureScript, [
    '$payload = [ordered]@{',
    '  ProcessPath = (Get-Process -Id $PID).Path',
    '  Edition = $PSVersionTable.PSEdition',
    '  Major = $PSVersionTable.PSVersion.Major',
    '  ProcessPolicy = $env:PSExecutionPolicyPreference',
    '  CommandLine = [Environment]::CommandLine',
    '}',
    '$payload | ConvertTo-Json -Compress | Set-Content -LiteralPath $env:CODEX_SHARED_LAUNCHER_TEST_OUTPUT -Encoding UTF8',
  ].join('\r\n'), 'utf8');

  compile(compiler, executable, [sourcePath], null, 'winexe');

  const environment = {
    ...process.env,
    CODEX_SHARED_LAUNCHER_TEST_OUTPUT: output,
    PSExecutionPolicyPreference: 'Bypass',
  };
  const launched = spawnSync(executable, ['--no-dialogs'], { env: environment, encoding: 'utf8' });
  assert.equal(launched.status, 0, launched.stderr || launched.stdout);
  await waitForFile(output);

  const payload = JSON.parse(fs.readFileSync(output, 'utf8').replace(/^\uFEFF/, ''));
  const executableName = path.basename(payload.ProcessPath).toLowerCase();
  assert.ok(
    executableName === 'pwsh.exe' || executableName === 'powershell.exe',
    `Unexpected shell executable: ${payload.ProcessPath}`,
  );
  if (executableName === 'pwsh.exe') {
    assert.equal(payload.Edition, 'Core');
  } else {
    assert.equal(payload.Edition, 'Desktop');
    assert.ok(payload.Major >= 5);
  }
  assert.ok(payload.ProcessPolicy == null || payload.ProcessPolicy === '');
  assert.doesNotMatch(payload.CommandLine, /(?:^|\s)-ExecutionPolicy(?:\s|$)/i);

  assert.match(payload.CommandLine, /(?:^|\s)-NoDialogs(?:\s|$)/i);
});

function windowsPowerShell() {
  return path.join(process.env.WINDIR ?? String.raw`C:\Windows`, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

test('a reader holding progress open cannot abort startup or damage its last snapshot', context => {
  if (process.platform !== 'win32') { context.skip('Windows file sharing.'); return; }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-progress-sharing-'));
  const harness = path.join(directory, 'probe.ps1');
  const quote = value => `'${value.replaceAll("'", "''")}'`;
  context.after(() => {
    for (const name of fs.readdirSync(directory)) fs.unlinkSync(path.join(directory, name));
    fs.rmdirSync(directory);
  });
  fs.writeFileSync(harness, `
$ErrorActionPreference = 'Stop'
. ${quote(path.join(launcherRoot, 'CodexRuntimeHandoff.ps1'))}
$ast = [System.Management.Automation.Language.Parser]::ParseFile(${quote(path.join(launcherRoot, 'Start-CodexShared.ps1'))}, [ref]$null, [ref]$null)
foreach ($function in $ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -in @('Write-LauncherLog', 'Write-LauncherProgress') }, $false)) {
    . ([scriptblock]::Create($function.Extent.Text))
}
$ProgressPath = Join-Path $PSScriptRoot 'progress.json'
$logPath = Join-Path $PSScriptRoot 'launcher.log'
$ProgressOwnerProcessId = 99
Write-LauncherProgress -Phase 'server-ready' -Summary 'Server ready'
$legacy = [IO.File]::Open($ProgressPath, 'Open', 'Read', 'Read')
try {
    Write-LauncherProgress -Phase 'desktop-starting' -Summary 'Opening Desktop'
    $held = (Read-CodexHandoffJson $ProgressPath).phase
} finally { $legacy.Dispose() }
$reader = [IO.File]::Open($ProgressPath, 'Open', 'Read', ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
try {
    Write-LauncherProgress -Phase 'ready' -Summary 'Connected'
    $published = Read-CodexHandoffJson $ProgressPath
    $snapshot = [IO.StreamReader]::new($reader)
    try { $previous = ($snapshot.ReadToEnd() | ConvertFrom-Json).phase } finally { $snapshot.Dispose() }
} finally { $reader.Dispose() }
@{ held=$held; previous=$previous; published=$published.phase; owner=$published.launcherProcessId; logged=(Test-Path $logPath) } | ConvertTo-Json -Compress
`);
  const result = JSON.parse(execFileSync(windowsPowerShell(), ['-NoProfile', '-NonInteractive', '-File', harness], { encoding: 'utf8' }));
  assert.deepEqual(result, { held: 'server-ready', previous: 'server-ready', published: 'ready', owner: 99, logged: true });
});

function startupFixture(directory, mode) {
  const launcher = path.join(directory, 'launcher');
  fs.mkdirSync(launcher, { recursive: true });
  fs.writeFileSync(path.join(launcher, 'Start-CodexShared.ps1'), [
    'param([switch]$NoDialogs,[switch]$InteractiveWorker,[string]$RetryStep,[string]$ProgressPath)',
    `$mode = '${mode}'`,
    '$requestPath = Join-Path $PSScriptRoot "requests.txt"',
    'Add-Content -LiteralPath $requestPath -Value $RetryStep',
    'if ($mode -eq "cancel") {',
    '  while (-not (Test-Path -LiteralPath "$ProgressPath.cancel")) { Start-Sleep -Milliseconds 50 }',
    '  Set-Content -LiteralPath (Join-Path $PSScriptRoot "cancelled.txt") -Value "cancelled"',
    '  exit 0',
    '}',
    '$phase = if ($mode -eq "skip" -or $mode -eq "delayed-skip" -or $RetryStep -eq "Desktop") { "skipped" } else { "failed" }',
    '$payload = [ordered]@{ launcherProcessId=$PID; phase=$phase; step="Desktop"; summary="fixture summary"; detail="fixture connection failure"; serverStatus="unverified"; desktopStatus= $(if ($phase -eq "skipped") { "running (skipped)" } else { "failed" }); logPath=$requestPath }',
    '[IO.File]::WriteAllText($ProgressPath, ($payload | ConvertTo-Json), [Text.UTF8Encoding]::new($false))',
    'if ($mode -eq "delayed-fail" -or $mode -eq "delayed-skip") { Start-Sleep -Seconds 2 }',
    'exit $(if ($phase -eq "failed") { 1 } else { 0 })',
  ].join('\r\n'), 'utf8');
  return launcher;
}

function compileUiHarness(directory) {
  const harness = path.join(directory, 'UiHarness.cs');
  fs.writeFileSync(harness, [
    'using System;',
    'using System.Diagnostics;',
    'using System.Linq;',
    'using System.Web.Script.Serialization;',
    'using System.Windows.Forms;',
    'internal static class UiHarness {',
    ' [STAThread] static int Main(string[] args) {',
    '  Application.EnableVisualStyles();',
    '  var info = new ProcessStartInfo(args[0], "-NoProfile -NonInteractive -File " + (char)34 + args[1] + (char)34) { UseShellExecute=false, CreateNoWindow=true };',
    '  var form = new SharedLaunchProgressForm(args[2], info);',
    '  var timer = new Timer { Interval=100 };',
    '  var watch = Stopwatch.StartNew();',
    '  bool retried=false, requestedClose=false;',
    '  string initialElapsed=null;',
    '  string initialDesktopStatus=null;',
    '  var grid = form.Controls.OfType<DataGridView>().Single();',
    '  form.FormClosed += delegate {',
    '   Console.Write(new JavaScriptSerializer().Serialize(new { result=form.ResultCode, initial=initialDesktopStatus, rows=grid.Rows.Cast<DataGridViewRow>().Select(r=>Convert.ToString(r.Cells[1].Value)).ToArray(), details=form.Controls.OfType<TextBox>().Single().Text, enabled=grid.Enabled, initialElapsed=initialElapsed, finalElapsed=Convert.ToString(grid.Rows[3].Cells[1].Value), autoClosed=!requestedClose, closedAfter=watch.ElapsedMilliseconds }));',
    '  };',
    '  timer.Tick += delegate {',
    '   if (args[3]=="cancel" && watch.ElapsedMilliseconds>1000 && !requestedClose) { requestedClose=true; form.Close(); return; }',
    '   var status=Convert.ToString(grid.Rows[1].Cells[1].Value);',
    '   if (args[3]=="hold-close" && grid.Enabled && status=="running (skipped)" && watch.ElapsedMilliseconds>1500 && !requestedClose) { requestedClose=true; form.Close(); return; }',
    '   if ((status=="失敗" || status=="running (skipped)") && watch.ElapsedMilliseconds>1500 && initialElapsed==null) { initialElapsed=Convert.ToString(grid.Rows[3].Cells[1].Value); }',
    '   if (args[3]=="retry" && grid.Enabled && status=="失敗" && watch.ElapsedMilliseconds>1500 && !retried) {',
    '    initialDesktopStatus=Convert.ToString(grid.Rows[1].Cells[1].Value);',
    '    grid.Rows[1].Cells[2].AccessibilityObject.DoDefaultAction();',
    '    retried=true;',
    '   }',
    '   if (watch.ElapsedMilliseconds>(args[3]=="fail" ? 3500 : 18000)) {',
    '    requestedClose=true; timer.Stop(); form.Close();',
    '   }',
    '  };',
    '  form.Shown += delegate { form.Hide(); timer.Start(); };',
    '  Application.Run(form); timer.Dispose(); form.Dispose(); return 0;',
    ' }',
    '}',
  ].join('\r\n'), 'utf8');
  const executable = path.join(directory, 'UiHarness.exe');
  compile(compilerPath(), executable, [sourcePath, harness], 'UiHarness');
  return executable;
}

test('progress window records a failed step, displays its error, and retries only on an explicit row action', context => {
  if (process.platform !== 'win32') { context.skip('Windows-only UI.'); return; }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-progress-retry-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const launcher = startupFixture(directory, 'fail');
  const harness = compileUiHarness(directory);
  const result = JSON.parse(execFileSync(harness, [windowsPowerShell(), path.join(launcher, 'Start-CodexShared.ps1'), launcher, 'retry'], { encoding: 'utf8', timeout: 25000 }));
  assert.equal(result.initial, '失敗');
  assert.equal(result.result, 0);
  assert.equal(result.rows[1], 'running (skipped)');
  assert.match(result.details, /fixture connection failure/);
  assert.equal(result.enabled, true);
  assert.equal(result.autoClosed, true);
  assert.deepEqual(fs.readFileSync(path.join(launcher, 'requests.txt'), 'utf8').trim().split(/\r?\n/), ['All', 'Desktop']);
});

test('an already-open unverified Desktop is shown as skipped rather than startup failure', context => {
  if (process.platform !== 'win32') { context.skip('Windows-only UI.'); return; }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-progress-skip-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const launcher = startupFixture(directory, 'skip');
  const harness = compileUiHarness(directory);
  const result = JSON.parse(execFileSync(harness, [windowsPowerShell(), path.join(launcher, 'Start-CodexShared.ps1'), launcher, 'skip'], { encoding: 'utf8', timeout: 25000 }));
  assert.equal(result.result, 0);
  assert.equal(result.rows[1], 'running (skipped)');
  assert.match(result.rows[2], /スキップ/);
  assert.equal(result.enabled, true);
  assert.equal(result.autoClosed, true);
  assert.equal(result.initialElapsed, result.finalElapsed);
  assert.equal(fs.readdirSync(path.join(launcher, 'state')).some(name => name.endsWith('.cancel')), false);
});

test('a failure freezes elapsed time before worker cleanup finishes and leaves retries available', context => {
  if (process.platform !== 'win32') { context.skip('Windows-only UI.'); return; }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-progress-error-clock-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const launcher = startupFixture(directory, 'delayed-fail');
  const harness = compileUiHarness(directory);
  const result = JSON.parse(execFileSync(harness, [windowsPowerShell(), path.join(launcher, 'Start-CodexShared.ps1'), launcher, 'fail'], { encoding: 'utf8', timeout: 15000 }));
  assert.equal(result.result, 1);
  assert.equal(result.initialElapsed, result.finalElapsed);
  assert.equal(result.enabled, true);
  assert.equal(result.autoClosed, false);
  assert.match(result.details, /fixture connection failure/);
});

test('completion freezes displayed elapsed time and exits after the worker without cancellation', context => {
  if (process.platform !== 'win32') { context.skip('Windows-only UI.'); return; }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-progress-complete-clock-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const launcher = startupFixture(directory, 'delayed-skip');
  const harness = compileUiHarness(directory);
  const result = JSON.parse(execFileSync(harness, [windowsPowerShell(), path.join(launcher, 'Start-CodexShared.ps1'), launcher, 'skip'], { encoding: 'utf8', timeout: 25000 }));
  assert.equal(result.result, 0);
  assert.equal(result.initialElapsed, result.finalElapsed);
  assert.equal(result.autoClosed, true);
  assert.ok(result.closedAfter >= 2000, 'Do not close before the finite worker exits.');
  assert.equal(fs.readdirSync(path.join(launcher, 'state')).some(name => name.endsWith('.cancel')), false);
});

test('a completed launcher can be manually closed before automatic dismissal', context => {
  if (process.platform !== 'win32') { context.skip('Windows-only UI.'); return; }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-progress-hold-close-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const launcher = startupFixture(directory, 'skip');
  const harness = compileUiHarness(directory);
  const result = JSON.parse(execFileSync(harness, [windowsPowerShell(), path.join(launcher, 'Start-CodexShared.ps1'), launcher, 'hold-close'], { encoding: 'utf8', timeout: 15000 }));
  assert.equal(result.result, 0);
  assert.equal(result.autoClosed, false);
  assert.equal(fs.readdirSync(path.join(launcher, 'state')).some(name => name.endsWith('.cancel')), false);
});

test('closing a pending progress window requests cancellation and waits for its worker to end', context => {
  if (process.platform !== 'win32') { context.skip('Windows-only UI.'); return; }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-progress-close-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const launcher = startupFixture(directory, 'cancel');
  const harness = compileUiHarness(directory);
  execFileSync(harness, [windowsPowerShell(), path.join(launcher, 'Start-CodexShared.ps1'), launcher, 'cancel'], { encoding: 'utf8', timeout: 15000 });
  assert.equal(fs.readFileSync(path.join(launcher, 'cancelled.txt'), 'utf8').trim(), 'cancelled');
});

test('dependency failure publishes the actual error before a runtime can start', context => {
  if (process.platform !== 'win32') { context.skip('Windows-only launcher.'); return; }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-launcher-preamble-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const script = path.join(directory, 'Start-CodexShared.ps1');
  fs.copyFileSync(path.join(path.dirname(sourcePath), 'Start-CodexShared.ps1'), script);
  const progress = path.join(directory, 'progress.json');
  const launched = spawnSync(windowsPowerShell(), ['-NoProfile', '-NonInteractive', '-File', script,
    '-InteractiveWorker', '-NoDialogs', '-ProgressPath', progress], { encoding: 'utf8', timeout: 10000 });
  assert.equal(launched.status, 1, launched.stderr);
  const receipt = JSON.parse(fs.readFileSync(progress, 'utf8'));
  assert.equal(receipt.phase, 'failed');
  assert.equal(receipt.step, 'Shared');
  assert.match(receipt.detail, /Codex runtime cache helper was not found/);
});

test('a second launcher focuses the existing window and starts no additional worker', async context => {
  if (process.platform !== 'win32') { context.skip('Windows-only UI.'); return; }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-progress-single-'));
  const launcher = startupFixture(directory, 'fail');
  const executable = path.join(launcher, 'CodexSharedLauncher.exe');
  compile(compilerPath(), executable, [sourcePath], null, 'winexe');
  const first = spawn(executable, [], { stdio: 'ignore' });
  const finished = new Promise(resolve => first.once('exit', resolve));
  context.after(async () => {
    if (first.exitCode == null) {
      const script = `$p=Get-Process -Id ${first.pid}; if ($p.Path -ne '${executable.replaceAll("'", "''")}') { throw 'Wrong fixture identity.' }; [void]$p.CloseMainWindow()`;
      execFileSync(windowsPowerShell(), ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]);
      await finished;
    }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  await waitForFile(path.join(launcher, 'requests.txt'), 10000);
  const second = spawnSync(executable, [], { encoding: 'utf8', timeout: 10000 });
  assert.equal(second.status, 0, second.stderr);
  assert.deepEqual(fs.readFileSync(path.join(launcher, 'requests.txt'), 'utf8').trim().split(/\r?\n/), ['All']);
});
