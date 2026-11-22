import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { validateSharedRuntime, sharedStatePath } from '../control/codex-shared.mjs';
import { connectCanonical, readJson, deliveryFor } from '../control/shared-task-operations.mjs';
import { createRuntimeCompletionRoute } from '../launcher/runtime-completion-desktop.mjs';
import { deliverRuntimeCompletion } from '../launcher/runtime-update-drain.mjs';

const completionMonitors = new WeakMap();
const peerModels = new Set(['gpt-6-luna', 'gpt-6-sol', 'gpt-6.1-sol', 'gpt-6.1-terra']);
const peerEfforts = new Set(['low', 'medium', 'high', 'xhigh']);

async function readHistoryPage(client, params) {
  for (let attempt = 0; ; attempt++) {
    try { return await client.call('thread/turns/list', params); }
    catch (error) {
      if (attempt >= 9 || !error.message.includes('rollout at ') || !error.message.includes(' is empty')) throw error;
      // The accepted first input can precede the metadata projection. Retry only this read.
      await delay(Math.min(500, 50 * 2 ** attempt));
    }
  }
}

export async function connectPeer() {
  const before = readJson(sharedStatePath);
  const runtime = await validateSharedRuntime();
  const client = await connectCanonical();
  const after = readJson(sharedStatePath);
  if (client.url !== runtime.endpoint || before.startedAt !== after.startedAt
    || after.serverProcessId !== runtime.serverProcessId || after.websocketUrl !== runtime.endpoint
    || after.serverSha256?.toUpperCase() !== runtime.serverSha256) {
    client.close(); throw new Error('The canonical runtime changed while connecting; no request was dispatched.');
  }
  return { client, runtime };
}

export async function inspectPeer(client, threadId, turnId = null) {
  const { thread } = await client.call('thread/read', { threadId, includeTurns: false });
  const { goal } = await client.call('thread/goal/get', { threadId });
  return { thread, goal, ...await readTurn(client, threadId, turnId) };
}

async function readTurn(client, threadId, turnId = null) {
  let turn, cursor;
  do {
    let page;
    try {
      page = await readHistoryPage(client, {
        threadId, limit: 100, sortDirection: 'desc', itemsView: 'notLoaded', ...(cursor ? { cursor } : {}),
      });
    } catch (error) {
      if (!turnId && error.message.includes('is not materialized yet') && error.message.includes('before first user message')) {
        return { turn: null, materialized: false };
      }
      throw error;
    }
    turn = turnId ? page.data.find(t => t.id === turnId) : page.data[0];
    cursor = page.nextCursor;
  } while (!turn && turnId && cursor);
  if (turnId && !turn) throw new Error('The exact requested turn was not found.');
  return { turn: turn ?? null };
}

function requireRunnableGoal(goal) {
  if (['paused', 'budgetLimited', 'usageLimited'].includes(goal?.status)) throw Object.assign(new Error(`The selected goal is ${goal.status}; no peer input was sent.`), { notDispatched: true });
  if (Number.isFinite(goal?.tokenBudget) && goal.tokenBudget > 0
    && (!Number.isFinite(goal.tokensUsed) || goal.tokensUsed >= goal.tokenBudget)) {
    throw Object.assign(new Error('The selected goal budget is exhausted or its remaining allowance cannot be confirmed.'), { notDispatched: true });
  }
}

export async function sendPeer({ client, runtime, request, message, record, persist, routeFactory = createRuntimeCompletionRoute }) {
  for (const [key, allowed] of [['model', peerModels], ['effort', peerEfforts]]) {
    if (request[key] !== undefined && !allowed.has(request[key])) {
      throw Object.assign(new Error(`${key} must be one of: ${[...allowed].join(', ')}.`), { notDispatched: true });
    }
  }
  const canonical = readJson(runtime.statePath);
  const route = routeFactory(client, {
    endpoint: runtime.endpoint, expectedServerPid: runtime.serverProcessId,
    requestId: request.operationId,
  });
  if (!request.threadId) {
    if (!request.create || !request.workspace) throw new Error('Select an exact threadId, or explicitly request create with a workspace.');
    record.phase = 'creating'; persist(record);
    const result = await client.call('thread/start', {
      cwd: request.workspace, model: request.model ?? 'gpt-6.1-sol',
      ...(request.effort !== undefined ? { config: { model_reasoning_effort: request.effort } } : {}),
      ...(request.mode === 'review' ? { sandbox: 'read-only' } : {}),
    });
    if (!result.thread?.id) throw new Error('Thread creation outcome is unknown; do not repeat.');
    request = { ...request, threadId: result.thread.id };
    record.threadId = request.threadId; record.phase = 'created'; persist(record);
  }
  const before = await inspectPeer(client, request.threadId);
  if (request.workspace && path.resolve(before.thread.cwd).toLowerCase() !== path.resolve(request.workspace).toLowerCase()) {
    throw new Error('The selected task belongs to a different workspace.');
  }
  // An explicit task request can add work, but never silently reactivate an intentionally paused goal.
  requireRunnableGoal(before.goal);
  record.threadId = request.threadId;
  record.runtime = { serverProcessId: canonical.serverProcessId, startedAt: canonical.startedAt };
  const completed = new Map();
  const capture = event => {
    if (event.method === 'turn/completed' && event.params?.threadId === request.threadId) completed.set(event.params.turn.id, true);
  };
  client.on('notification', capture);
  completionMonitors.set(client, { completed, capture });
  record.phase = 'dispatching'; persist(record);
  const guardedClient = { call: async (method, params, ...rest) => {
    if (method === 'turn/start' || method === 'turn/steer') {
      const { goal } = await client.call('thread/goal/get', { threadId: request.threadId });
      requireRunnableGoal(goal);
    }
    return client.call(method, params, ...rest);
  } };
  let delivery;
  if (before.materialized === false) {
    // The server explicitly reports that an empty thread has no turn history yet.
    route.verifyRuntime();
    const [method, params] = deliveryFor(request.threadId, null, message);
    const result = await guardedClient.call(method, params);
    if (!result.turn?.id) throw new Error('First turn outcome is unknown; do not repeat.');
    delivery = { accepted: true, threadId: request.threadId, turnId: result.turn.id, mode: 'start' };
  } else {
    delivery = await deliverRuntimeCompletion(guardedClient, request.threadId, message, route);
  }
  Object.assign(record, delivery, { phase: 'accepted' }); persist(record);
  return delivery;
}

export async function turnAnswer(client, threadId, turnId) {
  const { turn } = await readTurn(client, threadId, turnId);
  const messages = [];
  let cursor;
  do {
    const page = await client.call('thread/items/list', {
      threadId, limit: 100, sortDirection: 'desc', ...(cursor ? { cursor } : {}),
    });
    for (const entry of page.data ?? []) {
      if (entry.turnId === turnId && entry.item?.type === 'agentMessage') messages.push(entry.item);
    }
    cursor = page.nextCursor;
    if (messages.some(m => m.phase === 'final_answer') || !cursor) break;
  } while (cursor);
  const finals = messages.filter(m => m.phase == null || ['final_answer', 'final'].includes(m.phase));
  return { threadId, turnId, status: turn?.status ?? 'unavailable',
    answerAvailable: finals.length > 0,
    answer: finals.reverse().map(m => m.text ?? '').join('\n'),
    error: turn?.error ?? null };
}

export async function waitPeer(client, threadId, turnId) {
  const monitor = completionMonitors.get(client);
  let resolveFinished, rejectFinished;
  const finished = new Promise((resolve, reject) => { resolveFinished = resolve; rejectFinished = reject; });
  finished.catch(() => {});
  const notify = message => {
    if (message.method === 'turn/completed' && message.params?.threadId === threadId
      && message.params?.turn?.id === turnId) resolveFinished();
  };
  const disconnected = () => rejectFinished(new Error('Shared AppServer disconnected; the accepted operation must not be resent.'));
  client.on('notification', notify);
  client.on('disconnected', disconnected);
  try {
    // Readback closes the gap between dispatch and subscription. Later waits use events, not RPC polling.
    if (monitor?.completed.has(turnId)) resolveFinished();
    if (!monitor) {
      const initial = await readTurn(client, threadId, turnId);
      if (initial.turn?.status !== 'inProgress') return turnAnswer(client, threadId, turnId);
    }
    if (!client.connected) disconnected();
    await finished;
    // Completion can reach the socket before the shared history projection catches up.
    // Observe that same turn becoming terminal; never turn a transient inProgress read into failure.
    let observed = await readTurn(client, threadId, turnId);
    while (observed.turn?.status === 'inProgress') {
      if (!client.connected) throw new Error('Disconnected before terminal readback; do not resend the accepted request.');
      await delay(250);
      observed = await readTurn(client, threadId, turnId);
    }
    return turnAnswer(client, threadId, turnId);
  } finally {
    client.off('notification', notify); client.off('disconnected', disconnected);
    if (monitor) { client.off('notification', monitor.capture); completionMonitors.delete(client); }
  }
}
