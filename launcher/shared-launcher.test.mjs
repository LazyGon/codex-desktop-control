import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
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

test('interactive shared launcher exposes a compact verified progress window', () => {
  const source = fs.readFileSync(sourcePath, 'utf8');
  assert.match(source, /class SharedLaunchProgressForm : Form/);
  assert.match(source, /new DataGridView\(\)/);
  assert.match(source, /new ProgressBar\(\)/);
  assert.match(source, /desktopConnectionVerified/);
  assert.match(source, /desktopProcessIds/);
  assert.match(source, /HasLiveDesktopProcess/);
  assert.match(source, /ProbeLoopbackReady/);
  assert.match(source, /Application\.Run\(progressForm\)/);
  assert.match(source, /正常稼働中のアプリは残ります/);
  assert.match(source, /DataGridViewButtonColumn/);
  assert.match(source, /ProgressMutexName/);
  assert.match(source, /FormClosing \+= RequestClose/);
  assert.match(source, /if \(noDialogs\)[\s\S]*Process\.Start\(startInfo\)/);
});

function windowsPowerShell() {
  return path.join(process.env.WINDIR ?? String.raw`C:\Windows`, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

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
    'using System.Reflection;',
    'using System.Web.Script.Serialization;',
    'using System.Windows.Forms;',
    'internal static class UiHarness {',
    ' [STAThread] static int Main(string[] args) {',
    '  Application.EnableVisualStyles();',
    '  var info = new ProcessStartInfo(args[0], "-NoProfile -NonInteractive -File \\\"" + args[1] + "\\\"") { UseShellExecute=false, CreateNoWindow=true };',
    '  var form = new SharedLaunchProgressForm(args[2], info);',
    '  var timer = new Timer { Interval=100 };',
    '  var watch = Stopwatch.StartNew();',
    '  bool retried=false, requestedClose=false;',
    '  bool retryClockRunning=false;',
    '  long? initialElapsed=null;',
    '  string initialDesktopStatus=null;',
    '  var grid = form.Controls.OfType<DataGridView>().Single();',
    '  var elapsed = (Stopwatch)typeof(SharedLaunchProgressForm).GetField("elapsed", BindingFlags.Instance|BindingFlags.NonPublic).GetValue(form);',
    '  var completionDisplay = (Stopwatch)typeof(SharedLaunchProgressForm).GetField("completionDisplay", BindingFlags.Instance|BindingFlags.NonPublic).GetValue(form);',
    '  form.FormClosed += delegate {',
    '   Console.Write(new JavaScriptSerializer().Serialize(new { result=form.ResultCode, initial=initialDesktopStatus, rows=grid.Rows.Cast<DataGridViewRow>().Select(r=>Convert.ToString(r.Cells[1].Value)).ToArray(), details=form.Controls.OfType<TextBox>().Single().Text, enabled=grid.Enabled, elapsedRunning=elapsed.IsRunning, retryClockRunning=retryClockRunning, initialElapsed=initialElapsed, finalElapsed=elapsed.ElapsedMilliseconds, autoClosed=!requestedClose, closedAfter=watch.ElapsedMilliseconds, completionDisplayMs=completionDisplay.ElapsedMilliseconds }));',
    '  };',
    '  timer.Tick += delegate {',
    '   if (args[3]=="cancel" && watch.ElapsedMilliseconds>1000 && !requestedClose) { requestedClose=true; form.Close(); return; }',
    '   if (args[3]=="hold-close" && completionDisplay.IsRunning && watch.ElapsedMilliseconds>1500 && !requestedClose) { requestedClose=true; form.Close(); return; }',
    '   if (watch.ElapsedMilliseconds>1500 && !initialElapsed.HasValue) { initialElapsed=elapsed.ElapsedMilliseconds; }',
    '   if (args[3]=="retry" && watch.ElapsedMilliseconds>1500 && !retried) {',
    '    initialDesktopStatus=Convert.ToString(grid.Rows[1].Cells[1].Value);',
    '    typeof(SharedLaunchProgressForm).GetMethod("RetryStep", BindingFlags.Instance|BindingFlags.NonPublic).Invoke(form,new object[]{form,new DataGridViewCellEventArgs(2,1)});',
    '    retryClockRunning=elapsed.IsRunning;',
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
  assert.equal(result.elapsedRunning, false);
  assert.equal(result.autoClosed, true);
  assert.equal(result.retryClockRunning, true);
  assert.ok(result.completionDisplayMs >= 10000);
  assert.ok(result.completionDisplayMs < 11500);
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
  assert.equal(result.elapsedRunning, false);
  assert.equal(result.autoClosed, true);
  assert.equal(result.initialElapsed, result.finalElapsed);
  assert.ok(result.completionDisplayMs >= 10000);
  assert.ok(result.completionDisplayMs < 11500);
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
  assert.equal(result.elapsedRunning, false);
  assert.equal(result.initialElapsed, result.finalElapsed);
  assert.equal(result.enabled, true);
  assert.equal(result.autoClosed, false);
  assert.match(result.details, /fixture connection failure/);
});

test('completion freezes elapsed time, stays visible ten seconds, and exits without cancellation', context => {
  if (process.platform !== 'win32') { context.skip('Windows-only UI.'); return; }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-progress-complete-clock-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const launcher = startupFixture(directory, 'delayed-skip');
  const harness = compileUiHarness(directory);
  const result = JSON.parse(execFileSync(harness, [windowsPowerShell(), path.join(launcher, 'Start-CodexShared.ps1'), launcher, 'skip'], { encoding: 'utf8', timeout: 25000 }));
  assert.equal(result.result, 0);
  assert.equal(result.elapsedRunning, false);
  assert.equal(result.initialElapsed, result.finalElapsed);
  assert.equal(result.autoClosed, true);
  assert.ok(result.closedAfter >= 2000, 'Do not close before the finite worker exits.');
  assert.ok(result.completionDisplayMs >= 10000);
  assert.ok(result.completionDisplayMs < 11500);
  assert.equal(fs.readdirSync(path.join(launcher, 'state')).some(name => name.endsWith('.cancel')), false);
});

test('a completed launcher can be manually closed before its ten-second display ends', context => {
  if (process.platform !== 'win32') { context.skip('Windows-only UI.'); return; }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-progress-hold-close-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const launcher = startupFixture(directory, 'skip');
  const harness = compileUiHarness(directory);
  const result = JSON.parse(execFileSync(harness, [windowsPowerShell(), path.join(launcher, 'Start-CodexShared.ps1'), launcher, 'hold-close'], { encoding: 'utf8', timeout: 15000 }));
  assert.equal(result.result, 0);
  assert.equal(result.elapsedRunning, false);
  assert.equal(result.autoClosed, false);
  assert.ok(result.completionDisplayMs < 10000);
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
