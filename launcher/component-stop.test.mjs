import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const launcher = path.dirname(fileURLToPath(import.meta.url));
test('component stop identities, receipts, no replay and disposable-process termination', () => {
  const temporaryRoot = mkdtempSync(path.join(launcher, 'state', 'component-stop-test-'));
  const output = execFileSync('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-File', path.join(launcher, 'component-stop.test.ps1'),
    '-TemporaryRoot', temporaryRoot,
  ], { encoding: 'utf8', timeout: 120_000 });
  assert.match(output, /COMPONENT_STOP_OK/);
  const report = JSON.parse(readFileSync(path.join(temporaryRoot, 'test-report.json'), 'utf8'));
  assert.equal(report.completed, true);
  const invalidResult = path.join(temporaryRoot, 'invalid-id.json');
  const cli = spawnSync('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-File', path.join(launcher, 'Stop-CodexComponent.ps1'),
    '-Component', 'Shared', '-OperationId', '00000000-0000-0000-0000-000000000000',
    '-ResultPath', invalidResult, '-Force',
  ], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(cli.status, 2, cli.stderr);
  assert.equal(existsSync(invalidResult), false);
});
