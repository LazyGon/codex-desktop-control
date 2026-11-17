import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { readJson, saveJson, deliveryFor, connectCanonical } from './shared-task-operations.mjs';
import { restoreRecordedPause } from './paused-goal-continuation.mjs';
import { createRuntimeCompletionRoute } from '../launcher/runtime-completion-desktop.mjs';
import { deliverRuntimeCompletion } from '../launcher/runtime-update-drain.mjs';
export { deliveryFor } from './shared-task-operations.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function workerArguments(state, jobPath) {
  if (state.requireStandardUac) throw new Error('Per-job UAC is not supported; use the authorized common administrator client where permitted.');
  return ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', state.workerScript, '-JobPath', jobPath];
}

export function postbootOwnsCompletion(operation) {
  return operation?.apiReturn===0 && ['restart-request-accepted','unknown-do-not-repeat'].includes(operation.phase);
}

export function sameActiveGoal(current,recorded) {
  return current?.status==='active' && recorded?.status==='active'
    && ['threadId','objective','tokenBudget','createdAt'].every(key=>current[key]===recorded[key]);
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
    if(state.postbootOperationPath && fs.existsSync(state.postbootOperationPath)) {
      const operation=readJson(state.postbootOperationPath);
      if(operation.operationId!==state.operationId || operation.threadId!==state.threadId)throw new Error('Postboot operation owner mismatch.');
      if(postbootOwnsCompletion(operation)) {
        // A successful restart request returns before Windows actually shuts down.
        // Do not wake the paused owner in that gap; its logon receiver owns delivery.
        state.phase='awaiting-postboot';state.postbootOwnsCompletion=true;saveJson(jobPath,state);
        return;
      }
    }
    const client = await connectCanonical();
    try {
      const {thread}=await client.call('thread/read', { threadId: state.threadId, includeTurns: false });
      if(state.workspace&&path.resolve(thread.cwd).toLowerCase()!==path.resolve(state.workspace).toLowerCase())throw new Error('Completion owner workspace changed.');
      const canonical=readJson(path.join(repository,'launcher/state/current.json'));
      state.completionRouteRequestId??=randomUUID();saveJson(jobPath,state);
      const route=createRuntimeCompletionRoute(client,{endpoint:canonical.websocketUrl,expectedServerPid:canonical.serverProcessId,requestId:state.completionRouteRequestId});
      if(thread.status?.type==='notLoaded')await route.prepareDesktopThread(state.threadId);
      if(state.pausedGoalReadbackPath) {
        if(fs.existsSync(state.pausedGoalReadbackPath)) {
          const paused=readJson(state.pausedGoalReadbackPath);
          if(paused.threadId!==state.threadId || !state.recordedGoal || paused.goal?.objective!==state.recordedGoal.objective || paused.goal?.createdAt!==state.recordedGoal.createdAt || paused.goal?.tokenBudget!==state.recordedGoal.tokenBudget)throw new Error('Wrong completion goal owner or original goal.');
          state.restoredGoal=await restoreRecordedPause(client,paused,()=>{state.phase='restoring-recorded-goal';saveJson(jobPath,state);},{allowSourceInProgress:true});
        } else {
          const {goal}=await client.call('thread/goal/get',{threadId:state.threadId});
          if(thread.status?.type!=='active'||!sameActiveGoal(goal,state.recordedGoal))throw new Error('No unchanged active source for a failure before maintenance pause.');
        }
      }
      const instructions = state.completionInstructions ?? 'No reboot, firmware, or security changes are authorized without separate confirmation.';
      const message = `One-shot ${state.requestId} has finished its ${state.stage} worker. Read receipt ${state.receiptPath} and job ${jobPath} first. Continue only the authorized task described by this job. Do not repeat this worker or an uncertain operation. Preserve other tasks, workspace, permissions and model. ${instructions}`;
      state.phase = 'dispatching';saveJson(jobPath, state);
      const result = await deliverRuntimeCompletion(client,state.threadId,message,route);
      state.deliveryMethod=result.mode;
      state.acceptedTurnId = result.turnId;
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
