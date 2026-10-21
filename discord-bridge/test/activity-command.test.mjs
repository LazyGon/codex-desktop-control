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
    'powershell.exe -command Get-Process -Id 42');
  assert.equal(summarizeActivityCommand('cmd.exe /d /c "git status --short && git diff"'),
    'cmd.exe /c git status --short && git diff');
  assert.equal(summarizeActivityCommand('& "C:\\tools\\git.exe" diff; & "C:\\tools\\git.exe" status'),
    'git.exe diff ; git.exe status');
});

test('destructive options, targets, unknown flags and inline code are never silently omitted', () => {
  for (const command of [
    'git reset --hard HEAD~1', 'Remove-Item C:\\important -Recurse -Force',
    'powershell -ExecutionPolicy Bypass -Command "Remove-Item C:\\important -Force"',
    'node -e "console.log(1)" C:\\work\\data.json',
    'node --unknown-option value script.mjs',
  ]) assert.equal(summarizeActivityCommand(command), command);
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
});
