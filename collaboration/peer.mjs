import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, saveJson } from '../control/shared-task-operations.mjs';
import { connectPeer, inspectPeer, sendPeer, turnAnswer, waitPeer } from './codex-peer.mjs';
import { askClaude } from './claude-peer.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function operationDirectory(id, stateRoot = path.join(root, 'state/agent-collaboration')) {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id ?? '')) throw new Error('operationId must be a fresh UUID.');
  return path.join(stateRoot, id);
}

export async function runRequest(request, { stateRoot, connect = connectPeer, claude = askClaude } = {}) {
  const action = request.action ?? 'ask';
  if (!['codex', 'claude'].includes(request.peer)) throw new Error('peer must be codex or claude.');
  if (action === 'status') {
    const file = path.join(operationDirectory(request.operationId, stateRoot), 'result.json');
    const record = readJson(file);
    if (record.peer === 'codex' && record.accepted && record.threadId && record.turnId && record.phase !== 'completed') {
      const { client } = await connect();
      try {
        const result = await turnAnswer(client, record.threadId, record.turnId);
        const phase = result.status === 'inProgress' ? 'accepted'
          : result.status === 'completed' ? (result.answerAvailable ? 'completed' : 'result-unavailable') : 'failed';
        record.previousPhase = record.phase;
        Object.assign(record, result, { phase, observedAt: new Date().toISOString() }); saveJson(file, record);
      } finally { client.close(); }
    }
    return record;
  }
  if (action === 'read' || action === 'list') {
    if (request.peer !== 'codex') throw new Error('For Claude, retain the returned sessionId and continue with ask.');
    const { client } = await connect();
    try {
      if (action === 'list') return await client.call('thread/list', { limit: 30, archived: false, ...(request.search ? { searchTerm: request.search } : {}) });
      if (!request.threadId) throw new Error('An exact threadId is required.');
      return request.turnId ? await turnAnswer(client, request.threadId, request.turnId) : await inspectPeer(client, request.threadId);
    } finally { client.close(); }
  }
  if (action !== 'ask') throw new Error('action must be ask, read, list, or status.');
  request = { ...request, mode: request.mode ?? 'review' };
  if (!['review', 'implement'].includes(request.mode)) throw new Error('mode must be review or implement.');
  if (request.wait === false) throw new Error('Detached peer requests require a durable completion route; use the default synchronous request.');
  if (process.env.AGENT_COLLABORATION_WORKER === '1') throw new Error('A delegated worker must return to its caller instead of recursively delegating.');
  const message = fs.readFileSync(request.messageFile, 'utf8');
  if (!message.trim()) throw new Error('The request message is empty.');
  const directory = operationDirectory(request.operationId, stateRoot);
  fs.mkdirSync(path.dirname(directory), { recursive: true });
  try { fs.mkdirSync(directory); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const previous = readJson(path.join(directory, 'result.json'));
    return { ...previous, replayed: false, existingOperation: true };
  }
  const persist = record => saveJson(path.join(directory, 'result.json'), record);
  const record = { operationId: request.operationId, peer: request.peer, phase: 'prepared', startedAt: new Date().toISOString() };
  persist(record);
  // This is a notification deadline, never a model-execution time limit.
  record.notificationDueAt = new Date(Date.now() + 5 * 60_000).toISOString();
  record.notificationBasis = 'First progress notice after five minutes of an interactive peer request.';
  persist(record);
  const notice = setTimeout(() => {
    record.deadlineNotifiedAt = new Date().toISOString(); persist(record);
    process.stderr.write(JSON.stringify({ notification: 'peer-still-pending', operationId: request.operationId, phase: record.phase, directory }) + '\n');
  }, 5 * 60_000);
  let client;
  try {
    if (request.peer === 'codex') {
      record.requestedSettings = {
        ...(request.model !== undefined ? { model: request.model } : {}),
        ...(request.effort !== undefined ? { effort: request.effort } : {}),
      };
    }
    const delegatedMessage = message + '\n\nDelegated peer task: stay within this request. Return findings and results to the caller; do not call another agent or expand permissions. Task mode: ' + request.mode
      + (request.mode === 'review' ? '. This request is read-only; do not change files.' : '. Make only the changes authorized by the bounded task above.');
    if (request.peer === 'claude') {
      if (!request.workspace) throw new Error('workspace is required for Claude.');
      record.phase = 'dispatching'; persist(record);
      Object.assign(record, await claude(request, delegatedMessage, directory));
      record.phase = 'completed';
    } else {
      const connection = await connect(); client = connection.client;
      await sendPeer({ ...connection, request, message: delegatedMessage, record, persist });
      const result = await waitPeer(client, record.threadId, record.turnId);
      Object.assign(record, result, { phase: result.status === 'completed'
        ? (result.answerAvailable ? 'completed' : 'result-unavailable') : 'failed' });
    }
    record.updatedAt = new Date().toISOString(); persist(record); return record;
  } catch (error) {
    record.error = error.message;
    if (error.peerResult) Object.assign(record, error.peerResult);
    if (error.knownFailure || error.notDispatched) record.phase = 'failed';
    else if (['creating', 'dispatching'].includes(record.phase)) record.phase = 'unknown-do-not-resend';
    else if (record.phase === 'accepted') record.phase = 'result-unavailable';
    else record.phase = 'failed';
    persist(record); return record;
  } finally { clearTimeout(notice); client?.close(); }
}

async function main() {
  const [requestPath, ...extra] = process.argv.slice(2);
  if (!requestPath || extra.length) throw new Error('Usage: node collaboration/peer.mjs REQUEST.json (message text stays in messageFile).');
  const result = await runRequest(readJson(path.resolve(requestPath)));
  process.stdout.write(JSON.stringify(result) + '\n');
  if (['failed', 'unknown-do-not-resend', 'result-unavailable'].includes(result.phase)) process.exitCode = 1;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
}
