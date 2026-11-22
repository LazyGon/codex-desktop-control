import path from 'node:path';
import { validateSharedRuntime, sharedStatePath } from '../control/codex-shared.mjs';
import { connectCanonical, readJson, deliveryFor } from '../control/shared-task-operations.mjs';
import { createRuntimeCompletionRoute } from '../launcher/runtime-completion-desktop.mjs';
import { rolloutOutcome, rolloutTurn } from './rollout-truth.mjs';

const completionMonitors = new WeakMap();
const unsupportedHistory = new WeakSet();
const peerModels = new Set(['gpt-6-luna', 'gpt-6-sol', 'gpt-6.1-sol', 'gpt-6.1-terra']);
const peerEfforts = new Set(['low', 'medium', 'high', 'xhigh']);

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
  return { thread, goal, ...await readTurn(client, threadId, turnId, thread) };
}

async function readTurn(client, threadId, turnId = null, metadata = null) {
  if (!unsupportedHistory.has(client)) {
    try {
      const { thread } = await client.call('thread/read', { threadId, includeTurns: true });
      const turns = thread.turns ?? [];
      return { turn: (turnId ? turns.find(t => t.id === turnId) : turns.at(-1)) ?? null, materialized: turns.length > 0 };
    } catch (error) {
      if (error.code === -32601 || /"code":-32601/.test(error.message)) unsupportedHistory.add(client);
      else if (!turnId && /before first user message|rollout at .* is empty/.test(error.message)) {
        return { turn: null, materialized: false };
      } else throw error;
    }
  }
  metadata ??= (await client.call('thread/read', { threadId, includeTurns: false })).thread;
  const turn = rolloutTurn(threadId, turnId, { file: metadata.path });
  return { turn, materialized: !!turn, verifiedBy: 'rollout' };
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
  if (request.deliveryRoute !== undefined && !['desktop', 'appserver'].includes(request.deliveryRoute)) {
    throw Object.assign(new Error('deliveryRoute must be desktop or appserver.'), { notDispatched: true });
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
  let mutationAttempted = false;
  try {
    if (before.thread.status?.type === 'notLoaded') {
      record.phase = 'preparing'; persist(record);
      route.verifyRuntime();
      if (request.deliveryRoute === 'appserver') {
        // Only an unloaded task may be loaded here. Never resume a loaded owner.
        const { thread } = await client.call('thread/read', { threadId: request.threadId, includeTurns: false });
        if (thread.status?.type === 'notLoaded') await client.call('thread/resume', { threadId: request.threadId, excludeTurns: true });
      } else {
        await route.prepareDesktopThread(request.threadId);
      }
    }
    // Read current goal and exact turn after loading, immediately before dispatch.
    const latest = await inspectPeer(client, request.threadId);
    requireRunnableGoal(latest.goal);
    if (latest.thread.status?.type === 'active' && latest.turn?.status !== 'inProgress') {
      throw new Error('The running turn is not projected yet; no peer input was sent.');
    }
    const active = latest.turn?.status === 'inProgress' ? latest.turn : null;
    const [method, params] = deliveryFor(request.threadId, active, message);
    route.verifyRuntime();
    record.phase = 'dispatching'; persist(record);
    mutationAttempted = true;
    const result = await client.call(method, params);
    const turnId = result?.turn?.id ?? result?.turnId;
    if (!turnId || (active && turnId !== active.id) || (result.threadId && result.threadId !== request.threadId)) {
      throw new Error('Peer delivery uncertain; do not resend.');
    }
    const delivery = { accepted: true, threadId: request.threadId, turnId, mode: active ? 'steer' : 'start' };
    Object.assign(record, delivery, { phase: 'accepted' }); persist(record);
    return delivery;
  } catch (error) {
    const rejected = /"code":-3260[012](?:,|})/.test(error.message);
    if (!mutationAttempted || rejected) {
      error.notDispatched = true;
      record.deliveryEvidence = { previousTurnId: before.turn?.id ?? null, turnMutationAttempted: mutationAttempted, ...(rejected ? { inputRejected: true } : {}) };
      try {
        const after = await inspectPeer(client, request.threadId);
        Object.assign(record.deliveryEvidence, { threadStatus: after.thread.status, lastTurnId: after.turn?.id ?? null,
          rolloutPath: after.thread.path });
      } catch (readError) { record.waiterWarning = readError.message; }
      record.fallback = { deliveryRoute: 'appserver', threadId: request.threadId, safeToResend: true };
    }
    throw error;
  }
}

const terminalStatuses = new Set(['completed', 'failed', 'interrupted', 'aborted']);
export function taskPhase(result) {
  return result.status === 'completed' ? 'completed' : terminalStatuses.has(result.status) ? 'failed' : 'accepted';
}

export async function turnAnswer(client, threadId, turnId) {
  const base = { threadId, turnId, status: 'inProgress', answerAvailable: false, answer: '', error: null };
  try {
    const outcome = rolloutOutcome(threadId, turnId);
    if (outcome) return { ...base, status: outcome.type === 'task_complete' ? 'completed' : 'interrupted',
      answerAvailable: outcome.type === 'task_complete', answer: outcome.answer, verifiedBy: 'rollout' };
    const { turn, verifiedBy } = await readTurn(client, threadId, turnId);
    if (!turn) return { ...base, waiterWarning: 'The exact requested turn is not projected yet.' };
    const finals = (turn.items ?? []).filter(m => m.type === 'agentMessage' && (m.phase == null || ['final_answer', 'final'].includes(m.phase)));
    return { ...base, status: turn.status, error: turn.error ?? null, answerAvailable: (verifiedBy === 'rollout' && turn.status === 'completed') || finals.length > 0,
      answer: turn.answer ?? finals.map(m => m.text ?? '').join('\n'), verifiedBy: verifiedBy ?? 'thread/read' };
  } catch (error) { return { ...base, waiterWarning: error.message }; }
}

export async function waitPeer(client, threadId, turnId, { pollIntervalMs = 45_000, onUpdate = () => {} } = {}) {
  const monitor = completionMonitors.get(client);
  let wake;
  const notify = event => {
    if (event.method === 'turn/completed' && event.params?.threadId === threadId && event.params?.turn?.id === turnId) wake?.();
  };
  const disconnected = () => wake?.();
  client.on('notification', notify);
  client.on('disconnected', disconnected);
  try {
    while (true) {
      // Notifications only wake this read. Neither missing events nor failed reads end a turn.
      const result = await turnAnswer(client, threadId, turnId);
      onUpdate(result);
      if (terminalStatuses.has(result.status)) return result;
      let timer;
      try {
        await new Promise(resolve => {
          wake = resolve;
          timer = setTimeout(resolve, monitor?.completed.has(turnId) ? 250 : pollIntervalMs);
        });
      } finally { clearTimeout(timer); wake = null; }
    }
  } finally {
    client.off('notification', notify); client.off('disconnected', disconnected);
    if (monitor) { client.off('notification', monitor.capture); completionMonitors.delete(client); }
  }
}
