import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('Windows atomic JSON reads and event-only mirror observation survive controlled sharing', {
  skip: process.platform !== 'win32',
}, () => {
  const output = execFileSync('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe', [
    '-NoProfile', '-NonInteractive', '-File',
    fileURLToPath(new URL('./Test-AtomicJsonRead.ps1', import.meta.url)),
  ], { encoding: 'utf8', windowsHide: true });
  const result = JSON.parse(output);
  assert.equal(result.passed, true);
});
