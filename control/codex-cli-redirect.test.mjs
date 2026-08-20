import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const controlRoot = path.dirname(fileURLToPath(import.meta.url));
const installer = path.join(controlRoot, 'Install-CodexCliRedirect.ps1');

function psLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

test('CLI redirect installer owns reversible codex and codex-original shims', context => {
  if (process.platform !== 'win32') {
    context.skip('The CLI redirect installer is Windows-only.');
    return;
  }

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-cli-redirect-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const installRoot = path.join(directory, 'bin');
  const original = path.join(directory, 'codex.js');
  fs.writeFileSync(original, 'process.exitCode = 0;\n', 'utf8');

  const runInstaller = extra => execFileSync('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    [
      `& ${psLiteral(installer)}`,
      `-InstallRoot ${psLiteral(installRoot)}`,
      `-OriginalCodexJavaScript ${psLiteral(original)}`,
      '-SkipPathUpdate',
      ...extra,
    ].join(' '),
  ], { encoding: 'utf8' });

  runInstaller([]);
  for (const name of [
    'codex.cmd',
    'codex.ps1',
    'codex-original.cmd',
    'codex-original.ps1',
    'redirect.json',
  ]) {
    assert.equal(fs.existsSync(path.join(installRoot, name)), true, name);
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(installRoot, 'redirect.json'), 'utf8'));
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.originalCodexJavaScript, original);

  runInstaller(['-Uninstall']);
  assert.equal(fs.existsSync(installRoot), false);
});
