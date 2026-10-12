import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { readJson, saveJson, deliveryFor, connectCanonical } from './shared-task-operations.mjs';
export { deliveryFor } from './shared-task-operations.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function workerArguments(state, jobPath) {
  if (state.requireStandardUac) throw new Error('Per-job UAC is not supported; use the authorized common administrator client where permitted.');
  return ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', state.workerScript, '-JobPath', jobPath];
}

async function main() {
  const mode = process.argv[2];
  if (!process.argv[3]) throw new Error('An explicit local job JSON path is required.');
  const jobPath = path.resolve(process.argv[3]);
  const state = readJson(jobPath);
  if (mode === 'inspect') {
    const client = await connectCanonical();
    try {
      const own = (await client.call('thread/read', { threadId: state.threadId, includeTurns: false })).thread;
      const turns = await client.call('thread/turns/list', { threadId: state.threadId, limit: 10, sortDirection: 'desc', itemsView: 'notLoaded' });
      const active = turns.data.find(x => x.status === 'inProgress');
      const listed = await client.call('thread/list', { limit: 100, sortKey: 'updated_at', archived: false });
      console.log(JSON.stringify({ threadId: own.id, cwd: own.cwd, status: own.status, currentTurnId: active?.id ?? null, activeTaskCountOnFirstPage: listed.data.filter(x => x.status?.type === 'active').length, morePages: !!listed.nextCursor }));
    } finally { client.close(); }
    return;
  }
  if (mode !== 'run') throw new Error('Use inspect or run with a job JSON path.');
  if (state.phase !== 'prepared') throw new Error(`Job already admitted: ${state.phase}. No repeat.`);
  const lockPath = jobPath + '.lock';
  const lock = fs.openSync(lockPath, 'wx');
  try {
    workerArguments(state, jobPath); // Validate before admitting or spawning a worker.
    for (const pin of state.sourcePins ?? []) {
      const actual = createHash('sha256').update(fs.readFileSync(pin.file)).digest('hex').toUpperCase();
      if (actual !== pin.sha256.toUpperCase()) throw new Error('Pinned one-shot source changed; no worker was started.');
    }
    state.phase = 'armed'; state.controllerPid = process.pid; state.armedAt = new Date().toISOString(); saveJson(jobPath, state);
    const log = fs.openSync(state.workerLog, 'a');
    const worker = spawn(state.powerShell, workerArguments(state, jobPath), { cwd: repository, windowsHide: true, stdio: ['ignore', log, log] });
    state.workerPid = worker.pid; saveJson(jobPath, state);
    const outcome = await new Promise((resolve, reject) => { worker.once('error', reject); worker.once('exit', (code, signal) => resolve({ code, signal })); });
    fs.closeSync(log);
    state.workerExit = outcome; state.phase = 'ready'; state.workerFinishedAt = new Date().toISOString(); saveJson(jobPath, state);
    const client = await connectCanonical();
    try {
      await client.call('thread/read', { threadId: state.threadId, includeTurns: false });
      await client.call('thread/resume', { threadId: state.threadId, excludeTurns: true });
      const turns = await client.call('thread/turns/list', { threadId: state.threadId, limit: 10, sortDirection: 'desc', itemsView: 'notLoaded' });
      const active = turns.data.find(x => x.status === 'inProgress') ?? null;
      const instructions = state.completionInstructions ?? 'No reboot, firmware, or security changes are authorized without separate confirmation.';
      const message = `One-shot ${state.requestId} has finished its ${state.stage} worker. Read receipt ${state.receiptPath} and job ${jobPath} first. Continue only the authorized task described by this job. Do not repeat this worker or an uncertain operation. Preserve other tasks, workspace, permissions and model. ${instructions}`;
      const [method, params] = deliveryFor(state.threadId, active, message);
      state.phase = 'dispatching'; state.deliveryMethod = method; state.deliveryTurnId = active?.id ?? null; saveJson(jobPath, state);
      const result = await client.call(method, params);
      if (method === 'turn/start' && !result.turn?.id) throw new Error('Mutation returned no accepted turn ID. Do not resend.');
      if (method === 'turn/steer' && result.turnId !== active?.id) throw new Error('Steer did not confirm the expected exact turn ID. Do not resend.');
      state.acceptedTurnId = result.turn?.id ?? result.turnId;
      state.deliveryResult = result; state.phase = 'delivered'; state.deliveredAt = new Date().toISOString(); saveJson(jobPath, state);
    } finally { client.close(); }
  } catch (error) {
    state.failure = { name: error.name, message: error.message, at: new Date().toISOString() };
    state.phase = state.phase === 'dispatching' ? 'unknown-do-not-resend' : 'failed-no-resend';
    saveJson(jobPath, state); process.exitCode = 1;
  } finally { fs.closeSync(lock); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(); process.exit(process.exitCode ?? 0); }
  catch (error) { fs.writeSync(2, error.message + '\n'); process.exit(1); }
}
