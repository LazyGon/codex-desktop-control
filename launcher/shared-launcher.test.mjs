import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
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

test('shared launcher uses a supported shell without injecting execution policy', async context => {
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
  const launched = spawnSync(executable, [], { env: environment, encoding: 'utf8' });
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

  fs.rmSync(output);
  const automaticLaunch = spawnSync(executable, ['--no-dialogs'], { env: environment, encoding: 'utf8' });
  assert.equal(automaticLaunch.status, 0, automaticLaunch.stderr || automaticLaunch.stdout);
  await waitForFile(output);
  const automaticPayload = JSON.parse(fs.readFileSync(output, 'utf8').replace(/^\uFEFF/, ''));
  assert.match(automaticPayload.CommandLine, /(?:^|\s)-NoDialogs(?:\s|$)/i);
});
