import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const helper = path.join(import.meta.dirname, 'CodexNodeRuntime.ps1');
const ps = path.join(process.env.WINDIR ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const quote = v => `'${v.replaceAll("'", "''")}'`;
function resolve(root, searchPath = '') {
  const command = `. ${quote(helper)}; Get-CodexNodeExecutable -StateRoot ${quote(root)} -SearchPath ${quote(searchPath)}`;
  return execFileSync(ps, ['-NoProfile', '-NonInteractive', '-Command', command], {encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
}
test('launcher remembers workspace Node.js without changing the user PATH', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-node-runtime-'));
  try {
    fs.writeFileSync(path.join(root,'node-runtime.json'),JSON.stringify({schemaVersion:1,nodeExecutable:process.execPath}));
    assert.equal(resolve(root).toLowerCase(),process.execPath.toLowerCase());
    assert.equal(resolve(root, path.dirname(process.execPath)).toLowerCase(),process.execPath.toLowerCase());
    fs.writeFileSync(path.join(root,'node-runtime.json'),JSON.stringify({schemaVersion:1,nodeExecutable:process.execPath+'.missing'}));
    assert.throws(()=>resolve(root));
    fs.writeFileSync(path.join(root,'node-runtime.json'),'broken');
    assert.throws(()=>resolve(root));
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});

function bundledPowerShell(nodeExecutable) {
  return execFileSync(ps, ['-NoProfile', '-NonInteractive', '-Command',
    `. ${quote(helper)}; Get-CodexBundledPowerShellExecutable -NodeExecutable ${quote(nodeExecutable)}`
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

test('bundled PowerShell lookup leaves unrelated Node installs and missing bundles alone', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-powershell-missing-'));
  try {
    assert.equal(bundledPowerShell(path.join(root, 'node.exe')), '');
    assert.equal(bundledPowerShell(path.join(root, 'dependencies', 'node', 'bin', 'node.exe')), '');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('bundled PowerShell lookup rejects an unsigned sibling before adding it to PATH', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-powershell-untrusted-'));
  try {
    const candidate = path.join(root, 'dependencies', 'native', 'powershell', 'pwsh.exe');
    fs.mkdirSync(path.dirname(candidate), { recursive: true });
    fs.writeFileSync(candidate, 'not an executable');
    assert.throws(() => bundledPowerShell(path.join(root, 'dependencies', 'node', 'bin', 'node.exe')), /verified Microsoft PowerShell/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('launcher children resolve signed bundled PowerShell before the Store alias without registry changes', context => {
  const recordPath = path.join(import.meta.dirname, 'state', 'node-runtime.json');
  if (!fs.existsSync(recordPath)) { context.skip('No installed bundled runtime record.'); return; }
  const recorded = JSON.parse(fs.readFileSync(recordPath, 'utf8').replace(/^\uFEFF/, '')).nodeExecutable;
  const bundled = bundledPowerShell(recorded);
  if (!bundled) { context.skip('Installed Node has no bundled PowerShell sibling.'); return; }
  const command = [
    '[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)',
    '$env:PATHEXT=[Environment]::GetEnvironmentVariable("PATHEXT","Machine")',
    '$env:ComSpec=[Environment]::GetEnvironmentVariable("ComSpec","Machine")',
    '$userPathBefore=[Environment]::GetEnvironmentVariable("PATH","User")',
    '$machinePathBefore=[Environment]::GetEnvironmentVariable("PATH","Machine")',
    `. ${quote(helper)}`,
    `Initialize-CodexNodeRuntime -StateRoot ${quote(path.dirname(recordPath))} | Out-Null`,
    "$actualPowerShell = & pwsh -NoProfile -NonInteractive -Command '(Get-Process -Id $PID).Path'",
    '[ordered]@{ resolved=$actualPowerShell; userPathUnchanged=($userPathBefore -eq [Environment]::GetEnvironmentVariable("PATH","User")); machinePathUnchanged=($machinePathBefore -eq [Environment]::GetEnvironmentVariable("PATH","Machine")) } | ConvertTo-Json -Compress',
  ].join('; ');
  const result = JSON.parse(execFileSync(ps, ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8' }));
  assert.equal(result.resolved.toLowerCase(), bundled.toLowerCase());
  assert.equal(result.userPathUnchanged, true);
  assert.equal(result.machinePathUnchanged, true);
});
