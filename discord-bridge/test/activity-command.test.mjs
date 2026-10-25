import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeActivityCommand } from '../src/activity-command.mjs';
import { liveActivityItemText } from '../src/live-activity.mjs';

test('command captions shorten executable and script installation paths', () => {
  assert.equal(summarizeActivityCommand('C:\\runtime\\node.exe C:\\work\\scripts\\check.mjs'),
    'node.exe …/scripts/check.mjs');
  assert.equal(summarizeActivityCommand('& "C:\\Program Files\\node.exe" --test C:\\repo\\test\\one.test.mjs'),
    'node.exe --test …/test/one.test.mjs');
  assert.equal(summarizeActivityCommand('/opt/node/bin/node /work/scripts/check.mjs'),
    'node …/scripts/check.mjs');
  assert.equal(summarizeActivityCommand('git -C "C:\\work\\my repo" status --short'),
    'git -C "…/work/my repo" status --short');
  assert.equal(summarizeActivityCommand('"C:\\Program Files\\my tool.exe" --force'),
    '"my tool.exe" --force');
  assert.equal(summarizeActivityCommand('node --test C:\\repo\\test\\a.mjs C:\\repo\\test\\b.mjs'),
    'node --test …/test/a.mjs …/test/b.mjs');
});

test('known shell startup wrappers expose their actual operations and chain operators', () => {
  assert.equal(summarizeActivityCommand('powershell.exe -NoProfile -Command "Get-Process -Id 42"'),
    'Get-Process -Id 42');
  assert.equal(summarizeActivityCommand('cmd.exe /d /c "git status --short && git diff"'),
    'git status --short && git diff');
  assert.equal(summarizeActivityCommand('& "C:\\tools\\git.exe" diff; & "C:\\tools\\git.exe" status'),
    'git.exe diff ; git.exe status');
});

test('nested startup wrappers and invocation operators leave the actual command visible', () => {
  assert.equal(summarizeActivityCommand(`"C:\\runtime\\pwsh.exe" -Command 'git status --short'`),
    'git status --short');
  assert.equal(summarizeActivityCommand(`& 'C:\\Program Files\\PowerShell\\pwsh.exe' -NoLogo -NoProfile -NonInteractive -c 'Get-Process -Id 42'`),
    'Get-Process -Id 42');
  assert.equal(summarizeActivityCommand(`pwsh -Command 'cmd.exe /d /c "git diff --stat"'`),
    'git diff --stat');
  assert.equal(summarizeActivityCommand(`pwsh -Command '& "C:\\runtime\\node.exe" --test C:\\repo\\test\\one.test.mjs'`),
    'node.exe --test …/test/one.test.mjs');
  assert.equal(summarizeActivityCommand('cmd /c "git diff && git status" || echo failed'),
    '(git diff && git status) || echo failed');
  assert.equal(summarizeActivityCommand('echo before ; pwsh -Command "Get-Process -Id 42"'),
    'echo before ; (Get-Process -Id 42)');
});

test('opaque script bodies retain code, environment, working directory and multiline content', () => {
  for (const body of [
    '$env:MODE="safe"; Set-Location C:\\repo; node check.mjs',
    'Get-Process | Where-Object { $_.Id -eq 42 }',
    'Get-Item C:\\repo\nGet-Content C:\\repo\\input.json',
    'echo first > out.txt',
    'node -e "console.log(1)" C:\\work\\data.json',
  ]) assert.equal(summarizeActivityCommand(`pwsh -Command '${body}'`), body);
  // Adjacent quoted fragments are the argv display encoding of a literal quote,
  // not several commands. Preserve the decoded body even when it needs a parser.
  assert.equal(summarizeActivityCommand(`pwsh -Command 'Get-Item '"'"'C:\\my repo'"'"'; (Get-Process).Count'`),
    "Get-Item 'C:\\my repo'; (Get-Process).Count");
  assert.equal(summarizeActivityCommand('pwsh -Command "Write-Output \\"hello\\""'),
    'Write-Output "hello"');
});

test('destructive options, targets, unknown flags and inline code are never silently omitted', () => {
  for (const command of [
    'git reset --hard HEAD~1', 'Remove-Item C:\\important -Recurse -Force',
    'powershell -ExecutionPolicy Bypass -Command "Remove-Item C:\\important -Force"',
    'node -e "console.log(1)" C:\\work\\data.json',
    'node --unknown-option value script.mjs',
    'pwsh -WorkingDirectory C:\\repo -Command "git status"',
    'pwsh -EncodedCommand ZWNobyBoaQ==',
    'pwsh -NoExit -Command "git status"',
    'pwsh -Command -',
    'cmd /k "git status"',
    'cmd /v:on /c "echo !TARGET!"',
    'echo "pwsh -Command Get-Process"',
  ]) assert.equal(summarizeActivityCommand(command), command);
  assert.equal(summarizeActivityCommand(`pwsh -Command 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File ./scripts/invoke-node.ps1 --test'`),
    'powershell.exe -NoProfile -ExecutionPolicy Bypass -File ./scripts/invoke-node.ps1 --test');
  assert.equal(summarizeActivityCommand('C:\\tools\\git.exe clean -fdx C:\\important'),
    'git.exe clean -fdx C:\\important');
});

test('ambiguous shell syntax falls back to the exact original command', () => {
  for (const command of [
    'node "unterminated', 'echo value > out.txt', 'if ($ok) { node check.mjs }',
    'echo first\necho second', 'echo "a`"b"', 'node /tmp/a\\ b.mjs',
    'git status &&', 'powershell -Command "Write-Output `"hello`""',
    '& $command argument', '%COMSPEC% /c echo hello',
  ]) assert.equal(summarizeActivityCommand(command), command);
});

test('activity captions preserve failure status and exit code without mutating execution input', () => {
  const item = { type: 'commandExecution', command: 'C:\\runtime\\node.exe --test test/a.mjs', exitCode: 1 };
  const original = structuredClone(item);
  assert.equal(liveActivityItemText(item, true), '❌ node.exe --test test/a.mjs\nexit 1');
  assert.deepEqual(item, original);
  const wrapped = { ...item, command: 'pwsh -Command "git diff --stat"' };
  const wrappedOriginal = structuredClone(wrapped);
  assert.equal(liveActivityItemText(wrapped, true), '❌ git diff --stat\nexit 1');
  assert.deepEqual(wrapped, wrappedOriginal);
});
