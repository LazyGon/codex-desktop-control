import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const launcher = path.dirname(fileURLToPath(import.meta.url));
const windows = process.platform === 'win32';
const win = process.env.WINDIR ?? 'C:/Windows';
const ps = path.join(win, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const quote = value => "'" + String(value).replaceAll("'", "''") + "'";
function run(script) {
  return execFileSync(ps, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from("$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';" + script, 'utf16le').toString('base64')],
  { encoding: 'utf8', windowsHide: true, timeout: 45_000 });
}

function fixture(t) {
  const parent = path.resolve(os.tmpdir());
  const folder = fs.mkdtempSync(path.join(parent, 'codex-handoff-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(folder)), parent);
    fs.rmSync(folder, { recursive: true, force: true });
  });
  return folder;
}

test('nonzero legacy exit requires approval in both the manual request and observed drain', { skip: !windows }, () => {
  const output = run(`
    . ${quote(path.join(launcher, 'CodexRuntimeHandoff.ps1'))}
    $results=@()
    foreach($requested in @($false,$true)) {
      foreach($observed in @($false,$true)) {
        $request=[pscustomobject]@{ownerApprovedLegacyUpdate=$requested}
        $drain=[pscustomobject]@{phase='exited';exitCode=1;ownerApprovedLegacyUpdate=$observed}
        $results+= [bool](Test-CodexHandoffExitAccepted $request $drain)
      }
    }
    $results+= [bool](Test-CodexHandoffExitAccepted ([pscustomobject]@{}) ([pscustomobject]@{phase='exited';exitCode=0}))
    $results+= [bool](Test-CodexHandoffExitAccepted ([pscustomobject]@{ownerApprovedLegacyUpdate=$true}) ([pscustomobject]@{phase='shutdown-requested';exitCode=1;ownerApprovedLegacyUpdate=$true}))
    ConvertTo-Json -InputObject $results -Compress
  `);
  assert.deepEqual(JSON.parse(output), [false,false,false,true,true,false]);
});

test('the scheduled handoff starts only after a clean exit and does not repeat an unconfirmed launch', { skip: !windows }, t => {
  const dir = fixture(t);
  for (const file of ['Complete-CodexRuntimeHandoff.ps1', 'CodexRuntimeHandoff.ps1', 'CodexDesktopPackage.ps1', 'CodexRuntimeCache.ps1', 'CodexDesktopStartup.ps1']) {
    fs.copyFileSync(path.join(launcher, file), path.join(dir, file));
  }
  const app = path.join(dir, 'package', 'app');
  const res = path.join(app, 'resources');
  fs.mkdirSync(res, { recursive: true });
  const bytes = 'test bundled server';
  fs.writeFileSync(path.join(app, 'ChatGPT.exe'), '');
  for (const name of ['codex.exe', 'codex-code-mode-host.exe', 'codex-command-runner.exe',
    'codex-windows-sandbox-service.exe', 'codex-windows-sandbox-setup.exe']) {
    fs.writeFileSync(path.join(res, name), bytes);
  }
  const version = '26.1103.4239.0';
  const family = 'OpenAI.Codex_2p2nqsd0c76g0';
  const id = '0939b948-4e54-4945-b3ea-5724882e826e';
  const job = path.join(dir, 'state', 'runtime-handoffs', id);
  const launched = path.join(dir, 'launch.txt');
  fs.mkdirSync(job, { recursive: true });
  fs.writeFileSync(path.join(dir, 'Start-CodexShared.ps1'),
    "Add-Content -LiteralPath " + quote(launched) + " -Value ($args -join ' '); exit 1");
  const request = path.join(job, 'request.json');
  const baseRequest = {
    id, port: 52819, fromVersion: '26.1027.3384.0', toVersion: version, family,
    desktop: path.join(app, 'ChatGPT.exe'),
    serverSha256: createHash('sha256').update(bytes).digest('hex').toUpperCase(),
    oldServer: { pid: 2147483647, startedUtcTicks: '1' },
    oldSupervisor: { pid: 2147483646, startedUtcTicks: '1' },
    bridgeWasRunning: false, startupStallSeconds: 1,
  };
  fs.writeFileSync(request, JSON.stringify({ ...baseRequest, desktopBrowserAccessTrial: true }));
  const worker = path.join(dir, 'Complete-CodexRuntimeHandoff.ps1');
  const invoke = () => run(`
    function Get-AppxPackage { param($Name) [pscustomobject]@{
      Status='Ok'; SignatureKind='Store'; Version=${quote(version)};
      PackageFamilyName=${quote(family)}; InstallLocation=${quote(path.dirname(app))}
    } }
    function Get-NetTCPConnection { param($State,$LocalPort,$RemotePort) }
    function Get-Process { param($Id,$Name) }
    try { & ${quote(worker)} -RequestPath ${quote(request)} }
    catch { [Console]::WriteLine($_.Exception.Message) }
  `);
  const drain = path.join(job, 'drain.json');
  assert.match(invoke(), /limited to the inspected Desktop package/);
  assert.equal(fs.existsSync(launched), false);
  fs.writeFileSync(request, JSON.stringify({ ...baseRequest, fromVersion: version, desktopBrowserAccessTrial: true }));
  fs.writeFileSync(drain, JSON.stringify({ phase: 'exited', exitCode: 1 }));
  assert.match(invoke(), /did not record a clean exit/);
  assert.equal(fs.existsSync(launched), false);
  fs.writeFileSync(drain, JSON.stringify({ phase: 'exited', exitCode: 0 }));
  assert.match(invoke(), /No verified replacement/);
  const record = path.join(job, 'result.json');
  const first = JSON.parse(fs.readFileSync(record, 'utf8'));
  assert.ok(first.launchRequestedAt);
  assert.equal(first.desktopBrowserAccessTrial, true);
  assert.match(invoke(), /No verified replacement/);
  assert.equal(JSON.parse(fs.readFileSync(record, 'utf8')).launchRequestedAt, first.launchRequestedAt);
  const launches = fs.readFileSync(launched, 'utf8').trim().split(/\r?\n/);
  assert.equal(launches.length, 1);
  assert.match(launches[0], /(?:^| )-DesktopBrowserAccessTrial(?: |$)/);
});

test('shutdown reaches only the pinned isolated process and allows it to finish in-flight work', { skip: !windows }, t => {
  const dir = fixture(t);
  const source = path.join(dir, 'SignalFixture.cs');
  const exe = path.join(dir, 'SignalFixture.exe');
  fs.writeFileSync(source, `
using System;
using System.IO;
using System.Threading;
class SignalFixture {
    static int Main(string[] args) {
        var signal = new ManualResetEventSlim();
        Console.CancelKeyPress += (sender, e) => { e.Cancel = true; File.WriteAllText(args[1], "received"); signal.Set(); };
        File.WriteAllText(args[0], "ready");
        if (!signal.Wait(30000)) return 2;
        while (!File.Exists(args[2])) Thread.Sleep(20);
        return 0;
    }
}
  `);
  const compiler = path.join(win, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  execFileSync(compiler, ['/nologo', '/target:exe', '/out:' + exe, source], { windowsHide: true });
  const ready = path.join(dir, 'ready.txt');
  const received = path.join(dir, 'received.txt');
  const done = path.join(dir, 'done.txt');
  const senderResult = path.join(dir, 'sender.txt');
  const output = run(`
    . ${quote(path.join(launcher, 'CodexRuntimeHandoff.ps1'))}
    $argsLine = ${quote([ready, received, done].map(file => '"' + file + '"').join(' '))}
    $proc = Start-Process -FilePath ${quote(exe)} -ArgumentList $argsLine -WindowStyle Hidden -PassThru
    try {
      $timer = [Diagnostics.Stopwatch]::StartNew()
      while (-not (Test-Path -LiteralPath ${quote(ready)})) {
        if ($proc.HasExited -or $timer.Elapsed.TotalSeconds -ge 10) { throw 'Fixture did not start.' }
        Start-Sleep -Milliseconds 50
      }
      $wrong = Start-CodexHandoffChild ('"${path.join(launcher, 'Send-CodexAppServerShutdown.ps1')}" -ServerId {0} -Executable "${exe}" -StartedUtcTicks 1 -ResultPath "${senderResult}"' -f $proc.Id)
      $wrong.WaitForExit()
      if ($wrong.ExitCode -eq 0 -or (Test-Path -LiteralPath ${quote(received)})) { throw 'A different process incarnation was not rejected.' }
      Request-CodexAppServerShutdown $proc ${quote(senderResult)}
      $timer.Restart()
      while (-not (Test-Path -LiteralPath ${quote(received)})) {
        if ($proc.HasExited -or $timer.Elapsed.TotalSeconds -ge 5) { throw 'Signal not observed.' }
        Start-Sleep -Milliseconds 20
      }
      if ($proc.HasExited) { throw 'In-flight work was cut short.' }
      [IO.File]::WriteAllText(${quote(done)}, 'done')
      if (-not $proc.WaitForExit(5000) -or $proc.ExitCode -ne 0) { throw 'Graceful exit was not observed.' }
      'verified'
    }
    finally { if (-not $proc.HasExited) { $proc.Kill(); $proc.WaitForExit() }; $proc.Dispose() }
  `);
  assert.equal(output.trim(), 'verified');
});
