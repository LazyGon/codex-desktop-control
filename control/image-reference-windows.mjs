import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { exclusiveJson } from './image-repair-policy.mjs';
import { readJson } from './shared-task-operations.mjs';

export async function replaceArchivedImages(job, directory) {
  if (process.platform !== 'win32') throw Error('Atomic history replacement currently requires Windows');
  const jobPath = path.join(directory, 'replace-job.json');
  exclusiveJson(jobPath, job);
  const executable = path.join(process.env.SystemRoot || 'C:/Windows',
    'System32/WindowsPowerShell/v1.0/powershell.exe');
  const script = fileURLToPath(new URL('./Replace-ImageReferences.ps1', import.meta.url));
  const errorLog = fs.openSync(path.join(directory, 'replace-stderr.txt'), 'wx');
  const child = spawn(executable, ['-NoProfile', '-NonInteractive', '-File', script, '-JobPath', jobPath],
    { windowsHide: true, stdio: ['ignore', 'ignore', errorLog] });
  fs.closeSync(errorLog);
  await new Promise((resolve, reject) => {
    child.once('error', error => { error.notReplaced = true; reject(error); });
    child.once('exit', code => {
      if (code === 0) return resolve();
      let reason = 'Atomic replacement requires inspection';
      let notReplaced = false;
      try {
        const proof = readJson(job.resultPath); reason += ': ' + proof.error;
        notReplaced = proof.failedPhase === 'preflight';
      } catch { /* inspect native stderr */ }
      const error = Error(reason); error.notReplaced = notReplaced; reject(error);
    });
  });
  const result = readJson(job.resultPath);
  if (result.status !== 'verified' || result.operationId !== job.operationId
      || result.appliedSha256 !== job.manifest.outputSha256
      || result.backupSha256 !== job.manifest.sourceSha256) throw Error('Replacement result not verified');
  return result;
}
