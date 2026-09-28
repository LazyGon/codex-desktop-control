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
