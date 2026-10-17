import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const bridgeRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sourcePath = path.join(bridgeRoot, 'CodexDiscordRemoteHost.cs');

function compilerPath() {
  const windowsRoot = process.env.WINDIR ?? String.raw`C:\Windows`;
  return [
    path.join(windowsRoot, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    path.join(windowsRoot, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
  ].find(candidate => fs.existsSync(candidate));
}

function compileHarness(directory) {
  const compiler = compilerPath();
  assert.ok(compiler, 'The .NET Framework C# compiler must be available.');
  const executable = path.join(directory, 'BootstrapHarness.exe');
  const harness = path.join(directory, 'BootstrapHarness.cs');
  fs.writeFileSync(harness, [
    'using System;',
    'internal static class BootstrapHarness',
    '{',
    '    private static int Main(string[] args)',
    '    {',
    '        var info = CodexDiscordRemoteBootstrap.CreateSharedLauncherStartInfo(args[0]);',
    '        if (info == null) { Console.Write("NONE"); return 0; }',
    '        Console.WriteLine(info.FileName);',
    '        Console.WriteLine(info.Arguments);',
    '        Console.WriteLine(info.WorkingDirectory);',
    '        return 0;',
    '    }',
    '}',
  ].join('\r\n'), 'utf8');
  execFileSync(compiler, [
    '/nologo',
    '/target:exe',
    `/out:${executable}`,
    '/main:BootstrapHarness',
    '/reference:System.Drawing.dll',
    '/reference:System.Web.Extensions.dll',
    '/reference:System.Windows.Forms.dll',
    sourcePath,
    harness,
  ], { stdio: 'pipe' });
  return executable;
}

function compileRestartPolicyHarness(directory) {
  const compiler = compilerPath();
  assert.ok(compiler, 'The .NET Framework C# compiler must be available.');
  const executable = path.join(directory, 'RestartPolicyHarness.exe');
  const harness = path.join(directory, 'RestartPolicyHarness.cs');
  fs.writeFileSync(harness, [
    'using System;',
    'internal static class RestartPolicyHarness',
    '{',
    '    private static int Main(string[] args)',
    '    {',
    '        int exitCode = Int32.Parse(args[0]);',
    '        int attempts = Int32.Parse(args[1]);',
    '        Console.Write(CodexDiscordRemoteRestartPolicy.ShouldRestart(exitCode, attempts));',
    '        return 0;',
    '    }',
    '}',
  ].join('\r\n'), 'utf8');
  execFileSync(compiler, [
    '/nologo',
    '/target:exe',
    `/out:${executable}`,
    '/main:RestartPolicyHarness',
    '/reference:System.Drawing.dll',
    '/reference:System.Web.Extensions.dll',
    '/reference:System.Windows.Forms.dll',
    sourcePath,
    harness,
  ], { stdio: 'pipe' });
  return executable;
}

test('logon host prepares the configured shared launcher before Bridge cold start', (context) => {
  if (process.platform !== 'win32') {
    context.skip('The Discord Remote host is Windows-only.');
    return;
  }

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-remote-bootstrap-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const bridge = path.join(directory, 'discord-bridge');
  const launcherDirectory = path.join(directory, 'launcher');
  const launcher = path.join(launcherDirectory, 'CodexSharedLauncher.exe');
  fs.mkdirSync(path.join(bridge, 'config'), { recursive: true });
  fs.mkdirSync(launcherDirectory, { recursive: true });
  fs.writeFileSync(launcher, 'fixture');
  fs.writeFileSync(path.join(bridge, 'config', 'config.json'), JSON.stringify({
    autoStartSharedDesktop: true,
    sharedLauncherPath: String.raw`..\launcher\CodexSharedLauncher.exe`,
  }));

  const executable = compileHarness(directory);
  const output = execFileSync(executable, [bridge], { encoding: 'utf8' }).trim().split(/\r?\n/);
  assert.equal(output[0], launcher);
  assert.equal(output[1], '');
  assert.equal(output[2], launcherDirectory);
});

test('logon host honors autoStartSharedDesktop=false', (context) => {
  if (process.platform !== 'win32') {
    context.skip('The Discord Remote host is Windows-only.');
    return;
  }

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-remote-bootstrap-disabled-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const bridge = path.join(directory, 'discord-bridge');
  fs.mkdirSync(path.join(bridge, 'config'), { recursive: true });
  fs.writeFileSync(path.join(bridge, 'config', 'config.json'), JSON.stringify({
    autoStartSharedDesktop: false,
    sharedLauncherPath: String.raw`..\launcher\CodexSharedLauncher.exe`,
  }));

  const executable = compileHarness(directory);
  assert.equal(execFileSync(executable, [bridge], { encoding: 'utf8' }), 'NONE');
});

test('logon host retries only abnormal Bridge exits within the bounded policy', (context) => {
  if (process.platform !== 'win32') {
    context.skip('The Discord Remote host is Windows-only.');
    return;
  }

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-remote-restart-policy-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const executable = compileRestartPolicyHarness(directory);

  assert.equal(execFileSync(executable, ['134', '0'], { encoding: 'utf8' }).trim(), 'True');
  assert.equal(execFileSync(executable, ['0', '0'], { encoding: 'utf8' }).trim(), 'False');
  assert.equal(execFileSync(executable, ['134', '2147483647'], { encoding: 'utf8' }).trim(), 'False');
});
