import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { connectPeer, inspectPeer, turnAnswer } from '../../collaboration/codex-peer.mjs';
import { saveJson } from '../../control/shared-task-operations.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const retirementDirectory = path.join(repository, 'state/thread-retirement-20261122');
const protectedThreads = new Map([
  ['01a0e82f-1781-7881-b011-348df7758c19', 'RVM owner'],
  ['01a0e82f-1e78-7cc1-91b5-f08817e510b8', 'manager'],
  ['01a20313-5c16-7a61-a9a4-ee1e57762b7f', 'disk cleanup'],
  ['01a2030e-9483-7db2-9d19-8a78d2aefe64', 'card worker 3'],
  ['01a2030e-9457-75a0-b9aa-6baff28d71c0', 'card worker 4'],
  ['01a20323-24ff-7900-a4dd-0301781214f9', 'Task W result handoff'],
]);

export function refusalReason(threadId, snapshot, ownThreadId = process.env.CODEX_THREAD_ID) {
  if (protectedThreads.has(threadId)) return protectedThreads.get(threadId);
  if (threadId === ownThreadId) return 'own thread';
  if (snapshot.thread.id !== threadId) return 'thread identity mismatch';
  if (!['idle', 'notLoaded'].includes(snapshot.thread.status?.type)) return 'thread is not idle';
  if (snapshot.turn?.status !== 'completed') return 'last turn is not completed';
  if (snapshot.goal && snapshot.goal.status !== 'complete') return 'goal is ' + snapshot.goal.status;
  return null;
}

// An explicit CLI id or retire:true is the caller's declaration that the thread is throwaway.
export async function retireThread(threadId, { client, directory = retirementDirectory,
  ownThreadId = process.env.CODEX_THREAD_ID, inspect = inspectPeer, answer = turnAnswer } = {}) {
  if (!/^[a-zA-Z0-9-]+$/.test(threadId)) throw new Error('Invalid thread id');
  const folder = path.join(directory, threadId);
  fs.mkdirSync(folder, { recursive: true });
  const attemptFile = path.join(folder, Date.now() + '-' + crypto.randomUUID() + '.json');
  const record = { threadId, observedAt: new Date().toISOString(), phase: 'checking' };
  const persist = () => saveJson(attemptFile, record);
  persist();
  const lock = path.join(folder, 'lock');
  let locked = false, connection, dispatchStarted = false;
  try {
    try { fs.mkdirSync(lock); locked = true; }
    catch (error) { if (error.code !== 'EEXIST') throw error; record.phase = 'kept'; record.reason = 'retirement locked; no resend'; return record; }
    const dispatchFile = path.join(folder, 'delete.json');
    if (fs.existsSync(dispatchFile)) {
      record.phase = 'kept'; record.reason = 'prior delete attempt; no resend'; return record;
    }
    const protectedReason = protectedThreads.get(threadId) ?? (threadId === ownThreadId ? 'own thread' : null);
    if (protectedReason) { record.phase = 'kept'; record.reason = protectedReason; return record; }
    if (!client) { connection = await connectPeer(); client = connection.client; }
    const snapshot = await inspect(client, threadId);
    Object.assign(record, { thread: snapshot.thread, goal: snapshot.goal, turn: snapshot.turn });
    const reason = refusalReason(threadId, snapshot, ownThreadId);
    if (reason) { record.phase = 'kept'; record.reason = reason; return record; }
    const final = await answer(client, threadId, snapshot.turn.id);
    if (!final.answerAvailable) { record.phase = 'kept'; record.reason = 'final answer unavailable'; return record; }
    const rollout = snapshot.thread.path;
    const bytes = fs.readFileSync(rollout);
    record.rollout = { path: rollout, size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
    record.finalAnswer = final.answer;
    record.finalAnswerFile = path.join(folder, 'final-answer.txt');
    fs.writeFileSync(record.finalAnswerFile, final.answer);
    record.phase = 'preserved'; persist();
    // Preservation can take time: re-read immediately before the destructive call.
    const latest = await inspect(client, threadId);
    const latestReason = refusalReason(threadId, latest, ownThreadId);
    if (latestReason || latest.turn.id !== snapshot.turn.id) {
      record.phase = 'kept'; record.reason = latestReason ?? 'last turn changed'; return record;
    }
    record.phase = 'dispatching'; persist();
    const fd = fs.openSync(dispatchFile, 'wx');
    try { fs.writeFileSync(fd, JSON.stringify(record, null, 2)); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    dispatchStarted = true;
    try {
      record.result = await client.call('thread/delete', { threadId });
      record.phase = 'deleted';
    } catch (error) {
      record.phase = 'unknown-or-rejected'; record.error = error.message;
    }
    saveJson(dispatchFile, record);
    // A readback is observational only; an uncertain delete is never sent again.
    try { record.readback = (await client.call('thread/read', { threadId, includeTurns: false })).thread.id; }
    catch (error) { record.readbackError = error.message; }
    return record;
  } catch (error) {
    if (dispatchStarted) {
      if (record.phase !== 'deleted') record.phase = 'unknown-do-not-resend';
      record.error = error.message;
    } else { record.phase = 'kept'; record.reason = error.message; }
    return record;
  } finally {
    persist();
    if (locked) fs.rmdirSync(lock);
    connection?.client.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const ids = [...new Set(process.argv.slice(2))];
  if (!ids.length) { console.error('Usage: node retire-threads.mjs THREAD_ID...'); process.exitCode = 1; }
  else {
    for (const id of ids) {
      const result = await retireThread(id);
      console.log(JSON.stringify({ threadId: id, phase: result.phase, reason: result.reason }));
    }
    // AppServer close handshakes must not keep this one-shot CLI alive.
    process.exit();
  }
}
