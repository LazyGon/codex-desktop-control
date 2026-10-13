import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { connectCanonical, readJson, saveJson, deliveryFor } from './shared-task-operations.mjs';
import { uuidV7TimestampMs, turnTimestampMs } from '../discord-bridge/src/recent-history.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const defaultDirectory = path.join(root, 'state/global-system-error-recovery-20261013');
export const defaultConfig = Object.freeze({ schemaVersion: 1, enabled: true, excludedThreadIds: [],
  maxStartsPerCycle: 2, maxThreadsPerCycle: 32, cycleBudgetMs: 45_000, requestTimeoutMs: 5_000 });
const transient = new Set(['serverOverloaded', 'internalServerError', 'httpConnectionFailed',
  'responseStreamConnectionFailed', 'responseStreamDisconnected', 'responseTooManyFailedAttempts']);
const protectedGoals = new Set(['paused', 'complete', 'completed', 'budgetLimited', 'usageLimited']);
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort()
    .map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
const hash = value => crypto.createHash('sha256').update(canonical(value)).digest('hex');
const message = 'システムエラー終了からの自動再開です。同じ担当・保存済み進捗・元の設定と権限で、未完の許可済み作業だけを継続してください。利用者の停止／設計待ち／公開HOLDを守り、実行済み操作や送信結果UNKNOWNを再送しないでください。新しい範囲や権限は付与されません。';

export function errorKind(error) {
  const info = error?.codexErrorInfo;
  return typeof info === 'string' ? info : info && typeof info === 'object' && Object.keys(info).length === 1 ? Object.keys(info)[0] : null;
}
export function parentRelationship(thread) {
  const spawn = thread.source?.subAgent?.thread_spawn ?? thread.source?.subAgent?.threadSpawn;
  const fields = [thread.parentThreadId, spawn?.parent_thread_id, spawn?.parentThreadId].filter(x => x !== null && x !== undefined);
  if (fields.some(x => typeof x !== 'string' || !x) || new Set(fields).size > 1 || fields[0] === thread.id) {
    return { parentId: null, native: !!spawn, invalid: true };
  }
  return { parentId: fields[0] ?? null,
    native: !!spawn || thread.threadSource === 'subagent' || thread.canAcceptDirectInput === false,
    invalid: false };
}
export function terminalTransient(turns) {
  const last = turns[0];
  if (last?.status !== 'failed' || !last.id || !last.error) return false;
  const kind = errorKind(last.error), detail = last.error.codexErrorInfo?.[kind];
  const status = detail?.httpStatusCode ?? detail?.statusCode;
  return last.error.willRetry !== true && transient.has(kind)
    && !(Number.isInteger(status) && status >= 400 && status < 500 && ![408, 425, 429].includes(status));
}
export function parentNoticeKey(childId, failedTurnId, kind) {
  return hash({ domain: 'control-system-error-parent-notice/v1', childId, failedTurnId, kind });
}
export function goalIdentity(goal) {
  return goal ? hash({ objective: goal.objective, tokenBudget: goal.tokenBudget ?? null,
    createdAt: goal.createdAt ?? null }) : null;
}
export function observedGoalRecovery(thread, turns, goal, previous) {
  const active = previous?.activeGoalObservation, last = turns[0];
  return goal?.status === 'blocked' && active?.goalIdentity === goalIdentity(goal)
    && active.turnId === last?.id && active.turnStatus === 'inProgress'
    && last?.status === 'failed' && Number.isFinite(last.completedAt)
    && Number.isFinite(goal.updatedAt) && goal.updatedAt >= active.goalUpdatedAt
    && goal.updatedAt <= last.completedAt
    && Number.isFinite(active.observedAt) && active.observedAt <= last.completedAt * 1000
    && previous.latestTurnId === last.id && previous.latestTurnStatus === 'inProgress'
    && previous.goalStatus === 'active' && previous.identityHash === hashIdentity(thread);
}
export function eligibility(thread, turns, goal, excluded = [], previous = null) {
  if (excluded.includes(thread.id)) return 'excluded';
  if (parentRelationship(thread).invalid) return 'invalid-parent-source';
  if (parentRelationship(thread).native) return 'native-child-owner-route';
  if (thread.archived || thread.canAcceptDirectInput !== true) return 'not-confirmed-direct-input';
  if (thread.status?.type === 'active' || turns.some(t => t.status === 'inProgress')) return 'active';
  if (protectedGoals.has(goal?.status)) return 'protected-goal';
  if (Number.isFinite(goal?.tokenBudget) && goal.tokenBudget > 0
      && (!Number.isFinite(goal.tokensUsed) || goal.tokensUsed >= goal.tokenBudget)) return 'goal-budget-exhausted-or-unconfirmed';
  if (goal && !['active', 'blocked'].includes(goal.status)) return 'unknown-goal-status';
  if (goal?.status === 'blocked' && !observedGoalRecovery(thread, turns, goal, previous)) return 'blocked-cause-unproven';
  const last = turns[0];
  if (last?.status !== 'failed' || !last.error) return 'no-latest-terminal-error';
  const kind = errorKind(last.error);
  if (last.error.willRetry === true) return 'server-retrying';
  if (!transient.has(kind) && kind !== 'usageLimitExceeded') return 'non-retryable-error';
  const detail = last.error.codexErrorInfo?.[kind], status = detail?.httpStatusCode ?? detail?.statusCode;
  if (Number.isInteger(status) && status >= 400 && status < 500 && ![408, 425, 429].includes(status)) return 'permanent-http-error';
  if (!thread.id || !thread.cwd || !thread.model || !thread.modelProvider) return 'missing-identity';
  return 'eligible';
}
export function rateAvailable(result) {
  if (result?.ordinaryUsageAllowed !== true) return false;
  const all = [result.rateLimits, ...Object.values(result?.rateLimitsByLimitId ?? {})].filter(Boolean);
  return all.length > 0 && !all.some(limit => limit.spendControlReached === true
    || [limit?.primary, limit?.secondary].some(w => w && (!Number.isFinite(w.usedPercent) || w.usedPercent >= 100)));
}
export function episodeKey(threadId, turn) {
  // Error explanations may be decorated later; a single failed turn remains one episode.
  return hash({ domain: 'control-system-error-recovery/v1', threadId, turnId: turn.id });
}
export function backoffMs(count) { return Math.min(600_000, 60_000 * 2 ** Math.min(4, Math.max(0, count - 1))); }
function exclusive(file, value) {
  const fd = fs.openSync(file, 'wx');
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
}
export function sameIdentity(a, b) {
  return !!a && !!b && ['id', 'cwd', 'model', 'modelProvider', 'reasoningEffort', 'parentThreadId', 'agentRole']
    .every(k => (a[k] ?? null) === (b[k] ?? null));
}
function hashIdentity(thread) {
  return hash(Object.fromEntries(['id', 'cwd', 'model', 'modelProvider', 'reasoningEffort', 'parentThreadId', 'agentRole']
    .map(k => [k, thread[k] ?? null])));
}
export async function snapshot(client, id, timeout = 5_000) {
  const [read, listed] = await Promise.all([
    client.call('thread/read', { threadId: id, includeTurns: false }, timeout),
    client.call('thread/turns/list', { threadId: id, limit: 2, sortDirection: 'desc', itemsView: 'notLoaded' }, timeout),
  ]);
  if (read.thread?.id !== id || !Array.isArray(listed.data)) throw new Error('Incomplete snapshot');
  // Native metadata/turns remain readable even when that owner's goal API is unsupported.
  if (parentRelationship(read.thread).native) {
    // Same own-turn boundary as discord-controller.subagentOwnTurns. Never turn
    // an inherited parent failure into a new child's failure notice.
    const birth = uuidV7TimestampMs(read.thread.id)
      ?? (Number.isFinite(read.thread.createdAt) ? read.thread.createdAt * 1000 : null);
    const own = birth === null ? [] : listed.data.filter(turn => {
      const time = uuidV7TimestampMs(turn.id) ?? turnTimestampMs(turn);
      return time !== null && (time > birth || (time === birth && String(turn.id).localeCompare(read.thread.id) >= 0));
    });
    return { thread: read.thread, turns: own, goal: null, nativeGoalNotRead: true, nativeBirthCutKnown: birth !== null };
  }
  const gotGoal = await client.call('thread/goal/get', { threadId: id }, timeout);
  if (!gotGoal || !Object.hasOwn(gotGoal, 'goal')
      || (gotGoal.goal !== null && typeof gotGoal.goal !== 'object')) throw new Error('Incomplete snapshot');
  return { thread: read.thread, turns: listed.data, goal: gotGoal.goal };
}
function parentNoticeEligibility(s, config) {
  if (config.excludedThreadIds.includes(s.thread.id)) return 'excluded-parent';
  if (parentRelationship(s.thread).native || s.thread.canAcceptDirectInput !== true || s.thread.archived) return 'parent-owner-route-unavailable';
  if (protectedGoals.has(s.goal?.status) || s.goal?.status === 'blocked') return 'blocked-parent-goal';
  if (Number.isFinite(s.goal?.tokenBudget) && s.goal.tokenBudget > 0
      && (!Number.isFinite(s.goal.tokensUsed) || s.goal.tokensUsed >= s.goal.tokenBudget)) return 'parent-budget-exhausted';
  const active = s.turns.find(t => t.status === 'inProgress');
  if (s.goal && s.goal.status !== 'active') return 'unknown-parent-goal';
  if (active) return 'steer';
  if (s.thread.status?.type === 'active') return 'parent-active-turn-unavailable';
  if (s.turns[0]?.status === 'interrupted') return 'parent-intentionally-interrupted';
  return s.goal?.status === 'active' ? 'start' : 'idle-parent-without-active-goal';
}
// Notices have an independent claim. A failed notice must never repeat task recovery.
export async function notifyParent(client, child, failedTurnId, kind, store, config,
  now = Date.now, dryRun = false, allowStart = true) {
  const relation = parentRelationship(child.thread), key = parentNoticeKey(child.thread.id, failedTurnId, kind);
  if (!store.getNotice) return { action: 'notice-store-unavailable' };
  const old = store.getNotice(key);
  if (old && !['pending-parent', 'pending-read', 'pending-rate', 'pending-limit'].includes(old.phase)) return { action: 'notice-already-claimed', key };
  if (relation.invalid || !relation.parentId) {
    if (old && !dryRun) store.updateNotice(key, { ...old,
      phase: relation.invalid || relation.native ? 'pending-parent' : 'no-genuine-parent', reason: 'parent-source-unresolved' });
    return { action: 'no-genuine-parent', key };
  }
  if (kind === 'recovery') {
    const proof = store.getRecovery?.(child.thread.id, failedTurnId);
    if (!proof || (!proof.acceptedTurnId && proof.goalRestored !== true)) return { action: 'no-confirmed-recovery', key };
  }
  if (old?.parentId && old.parentId !== relation.parentId) return { action: 'parent-relation-changed', key };
  let record = old ? { ...old, parentId: relation.parentId } : { schemaVersion: 1, key, childId: child.thread.id, failedTurnId, kind,
    parentId: relation.parentId, phase: 'pending-parent', createdAt: new Date(now()).toISOString() };
  const save = () => {
    if (dryRun) return;
    if (store.getNotice(key)) store.updateNotice(key, record); else store.createNotice(key, record);
  };
  if (config.excludedThreadIds.includes(child.thread.id)) return { action: 'excluded-child', key };
  let parent;
  try { parent = await snapshot(client, relation.parentId, config.requestTimeoutMs); }
  catch { record.phase = 'pending-read'; save(); return { action: record.phase, key }; }
  const mode = parentNoticeEligibility(parent, config);
  if (!['steer', 'start'].includes(mode)) { record.phase = 'pending-parent'; record.reason = mode; save(); return { action: record.phase, reason: mode, key }; }
  if (mode === 'start') {
    if (!allowStart) { record.phase = 'pending-limit'; save(); return { action: record.phase, key }; }
    try {
      if (!rateAvailable(await client.call('account/rateLimits/read', {}, config.requestTimeoutMs))) {
        record.phase = 'pending-rate'; save(); return { action: record.phase, key };
      }
    } catch { record.phase = 'pending-read'; save(); return { action: record.phase, key }; }
  }
  let freshChild, freshParent;
  try {
    [freshChild, freshParent] = await Promise.all([snapshot(client, child.thread.id, config.requestTimeoutMs),
      snapshot(client, relation.parentId, config.requestTimeoutMs)]);
  } catch { record.phase = 'pending-read'; save(); return { action: record.phase, key }; }
  if (parentRelationship(freshChild.thread).parentId !== relation.parentId || !sameIdentity(child.thread, freshChild.thread)
      || (kind === 'native-failure' && (!terminalTransient(freshChild.turns) || freshChild.turns[0].id !== failedTurnId
        || freshChild.thread.status?.type === 'active'))) {
    record.phase = 'superseded-no-delivery'; save(); return { action: record.phase, key };
  }
  if (!sameIdentity(parent.thread, freshParent.thread) || goalIdentity(parent.goal) !== goalIdentity(freshParent.goal)
      || parentNoticeEligibility(freshParent, config) !== mode) {
    record.phase = 'pending-parent'; record.reason = 'parent-cut-changed'; save(); return { action: record.phase, key };
  }
  if (dryRun) return { action: 'would-notify-parent', key, mode, parentId: relation.parentId };
  if (store.allowed && (!store.allowed(child.thread.id) || !store.allowed(relation.parentId))) return { action: 'config-stopped', key };
  record.phase = 'prepared'; record.parentIdentitySha256 = hashIdentity(freshParent.thread);
  record.parentGoalIdentity = goalIdentity(freshParent.goal); save();
  try {
    if (mode === 'start') {
      record.phase = 'session-dispatching'; save();
      const restored = (await client.call('thread/resume', { threadId: relation.parentId, excludeTurns: true }, config.requestTimeoutMs)).thread;
      if (!sameIdentity(freshParent.thread, restored)) throw new Error('Parent identity drift');
      const [after, childAfter] = await Promise.all([snapshot(client, relation.parentId, config.requestTimeoutMs),
        snapshot(client, child.thread.id, config.requestTimeoutMs)]);
      if (!sameIdentity(freshParent.thread, after.thread) || goalIdentity(after.goal) !== record.parentGoalIdentity
          || parentNoticeEligibility(after, config) !== 'start' || parentRelationship(childAfter.thread).parentId !== relation.parentId
          || (kind === 'native-failure' && (!terminalTransient(childAfter.turns) || childAfter.turns[0].id !== failedTurnId
            || childAfter.thread.status?.type === 'active'))) {
        record.phase = 'changed-before-delivery'; save(); return { action: record.phase, key };
      }
      freshParent = after;
    }
    if (store.allowed && (!store.allowed(child.thread.id) || !store.allowed(relation.parentId))) {
      record.phase = 'config-stopped'; save(); return { action: record.phase, key };
    }
    const recovery = kind === 'recovery' ? store.getRecovery?.(child.thread.id, failedTurnId) : null;
    const text = kind === 'native-failure'
      ? `子task ${child.thread.id} の最新turn ${failedTurnId} が確定system errorで終了しました。真正の親への一度だけの通知です。最新child/statusを再読し、停止・HOLD・権限・設定を保ち、同じchildをsupported collaborationで保存済み進捗から再開してください。native childへのordinary直接resumeや担当変更は行わないでください。`
      : `子task ${child.thread.id} のsystem-error recovery（元failed turn ${failedTurnId}）について親へ一度だけ通知します。goalRestored=${recovery?.goalRestored === true}; acceptedTurnId=${recovery?.acceptedTurnId ?? recovery?.observedActiveTurnId ?? 'NONE'}; recoveryPhase=${recovery?.phase ?? 'UNKNOWN'}。現在cutを再読してください。UNKNOWN送信や元回復を再送せず、元の停止・設定・権限を保ってください。`;
    const active = mode === 'steer' ? freshParent.turns.find(t => t.status === 'inProgress') : null;
    const [method, params] = deliveryFor(relation.parentId, active, text);
    params.clientUserMessageId = 'system-error-parent-notice:' + key;
    record.phase = 'dispatching'; record.method = method; record.expectedTurnId = active?.id ?? null; save();
    const receipt = await client.call(method, params, config.requestTimeoutMs);
    const turnId = active ? receipt.turnId : receipt.turn?.id;
    if (!turnId || (active && turnId !== active.id)) throw new Error('Missing exact notice receipt');
    record.phase = 'accepted'; record.acceptedTurnId = turnId; save();
    return { action: 'parent-notified', key, parentId: relation.parentId, method, turnId, startedParentTurn: !active };
  } catch { record.phase = 'unknown-no-resend'; save(); return { action: record.phase, key }; }
}
function queueRecoveryNotice(store, recovery, now, dryRun) {
  if (dryRun || !store.createNotice || (!recovery.acceptedTurnId && recovery.goalRestored !== true)) return;
  const key = parentNoticeKey(recovery.threadId, recovery.failedTurnId, 'recovery');
  if (!store.getNotice(key)) store.createNotice(key, { schemaVersion: 1, key, childId: recovery.threadId,
    failedTurnId: recovery.failedTurnId, kind: 'recovery', parentId: null, phase: 'pending-read',
    createdAt: new Date(now()).toISOString(), recoveryKey: recovery.key });
}
function rotateNotices(rows, after) {
  const sorted = [...rows].sort((a, b) => a.key.localeCompare(b.key));
  const index = after ? sorted.findIndex(x => x.key > after) : 0;
  return index < 0 ? sorted : [...sorted.slice(index), ...sorted.slice(0, index)];
}
export function validateConfig(c) {
  if (c?.schemaVersion !== 1 || typeof c.enabled !== 'boolean' || !Array.isArray(c.excludedThreadIds)
      || c.excludedThreadIds.some(x => typeof x !== 'string')) throw new Error('Invalid config');
  for (const [k, lo, hi] of [['maxStartsPerCycle', 1, 10], ['maxThreadsPerCycle', 1, 100],
    ['cycleBudgetMs', 1_000, 60_000], ['requestTimeoutMs', 500, 15_000]]) {
    if (!Number.isInteger(c[k]) || c[k] < lo || c[k] > hi) throw new Error('Invalid ' + k);
  }
  if (c.maxParentNoticesPerCycle !== undefined && (!Number.isInteger(c.maxParentNoticesPerCycle)
      || c.maxParentNoticesPerCycle < 1 || c.maxParentNoticesPerCycle > 10)) throw new Error('Invalid maxParentNoticesPerCycle');
  return c;
}
function observation(thread, turns, goal, time, old = {}) {
  const next = { ...old, latestTurnId: turns[0]?.id ?? null, latestTurnStatus: turns[0]?.status ?? null,
    goalStatus: goal?.status ?? null, identityHash: hashIdentity(thread) };
  if (goal?.status === 'active') next.activeGoalObservation = { goalIdentity: goalIdentity(goal),
    goalUpdatedAt: goal.updatedAt ?? null, observedAt: time, turnId: turns[0]?.id ?? null, turnStatus: turns[0]?.status ?? null };
  if (turns[0]?.status === 'completed') { next.count = 0; next.nextEligibleAt = 0; }
  return next;
}

// Only terminal failure episodes qualify. A read/connection failure is never a task failure.
export async function runCycle(client, config, state, store, now = Date.now, dryRun = false) {
  validateConfig(config);
  const started = now();
  const report = { startedAt: new Date(started).toISOString(), dryRun, checked: 0, resumed: 0, results: [] };
  if (!config.enabled) return { ...report, disabled: true };
  state.threads ??= {};
  state.noticeQueue ??= { pendingAfterKey: null, singletonPendingTurn: false };
  // Reconstruct from the recovery journal even after a crash before finally/enqueue.
  for (const recovery of store.recoveryRecords?.() ?? []) queueRecoveryNotice(store, recovery, now, dryRun);
  report.parentNotices = []; report.noticeStarts = 0; report.parentNoticeAttempts = 0;
  const noticeLimit = config.maxParentNoticesPerCycle ?? 2;
  const notice = async (child, failedTurnId, kind) => {
    if (kind === 'recovery') {
      const recovery = store.getRecovery?.(child.thread.id, failedTurnId);
      if (recovery) queueRecoveryNotice(store, recovery, now, dryRun);
    }
    if (report.parentNoticeAttempts >= noticeLimit
        || now() - started >= config.cycleBudgetMs) return { action: 'notice-cycle-deferred' };
    const result = await notifyParent(client, child, failedTurnId, kind, store, config, now, dryRun,
      report.resumed + report.noticeStarts < config.maxStartsPerCycle);
    if (result.startedParentTurn) report.noticeStarts++;
    if (!['notice-already-claimed', 'no-genuine-parent', 'no-confirmed-recovery', 'excluded-child', 'notice-store-unavailable'].includes(result.action)) report.parentNoticeAttempts++;
    report.parentNotices.push({ childId: child.thread.id, failedTurnId, ...result }); return result;
  };
  const drainPending = async limit => {
    const pendingRows = rotateNotices(store.pendingNotices?.() ?? [], state.noticeQueue.pendingAfterKey);
    let examined = 0;
    for (const pending of pendingRows) {
      if (examined >= limit || report.parentNoticeAttempts >= noticeLimit || now() - started >= config.cycleBudgetMs) break;
      examined++;
      state.noticeQueue.pendingAfterKey = pending.key;
      if (!dryRun) store.saveState(state);
      try { await notice(await snapshot(client, pending.childId, config.requestTimeoutMs), pending.failedTurnId, pending.kind); }
      catch { report.parentNoticeAttempts++; report.parentNotices.push({ childId: pending.childId, action: 'pending-notice-read-failed' }); }
    }
  };
  // Leave one attempt for newly discovered failures. With limit1 alternate lanes.
  const initialPendingLimit = noticeLimit > 1 ? noticeLimit - 1 : state.noticeQueue.singletonPendingTurn ? 1 : 0;
  state.noticeQueue.singletonPendingTurn = !state.noticeQueue.singletonPendingTurn;
  await drainPending(initialPendingLimit);
  state.scan ??= { pendingIds: [], listCursor: null, loadedCursor: null };
  if (state.scan.pendingIds.length < 100) {
    const [rows, loaded] = await Promise.all([
      client.call('thread/list', { archived: false, limit: 10, sortKey: 'updated_at', sortDirection: 'desc',
        ...(state.scan.listCursor ? { cursor: state.scan.listCursor } : {}) }, Math.max(30_000, config.requestTimeoutMs)),
      client.call('thread/loaded/list', { limit: 100,
        ...(state.scan.loadedCursor ? { cursor: state.scan.loadedCursor } : {}) }, config.requestTimeoutMs),
    ]);
    if (!Array.isArray(rows.data) || !Array.isArray(loaded.data)) throw new Error('Invalid inventory page');
    for (const [key, page] of [['listCursor', rows], ['loadedCursor', loaded]]) {
      if (page.nextCursor && page.nextCursor === state.scan[key]) throw new Error('Repeated cursor');
      state.scan[key] = page.nextCursor ?? null;
    }
    state.scan.pendingIds = [...new Set([...state.scan.pendingIds, ...rows.data.map(r => r.id),
      ...loaded.data.map(r => typeof r === 'string' ? r : r.id)])].filter(Boolean);
  }
  const ids = state.scan.pendingIds.slice(0, config.maxThreadsPerCycle);
  if (!dryRun) store.saveState(state);
  for (let offset = 0; offset < ids.length; offset += 4) {
    if (now() - started >= config.cycleBudgetMs) break;
    const group = await Promise.allSettled(ids.slice(offset, offset + 4).map(id => snapshot(client, id, config.requestTimeoutMs)));
    for (let index = 0; index < group.length; index++) {
      const id = ids[offset + index], read = group[index];
      state.scan.pendingIds.shift();
      report.checked++;
      if (read.status === 'rejected') { report.results.push({ id, action: 'read-failed-no-mutation' }); continue; }
      const s = read.value, prior = state.threads[id] ?? {};
      const recoveryPrior = prior.recoveryObservation ?? prior;
      const eligible = eligibility(s.thread, s.turns, s.goal, config.excludedThreadIds, recoveryPrior);
      const entry = observation(s.thread, s.turns, s.goal, now(), prior);
      state.threads[id] = entry;
      // Retain the causal tuple across a preflight/read failure, before any mutation.
      if (eligible === 'eligible' && s.goal?.status === 'blocked' && !entry.recoveryObservation) entry.recoveryObservation = prior;
      if (entry.recoveryObservation?.latestTurnId !== s.turns[0]?.id) delete entry.recoveryObservation;
      if (!dryRun) store.saveState(state);
      const result = { id, action: eligible }; report.results.push(result);
      if (parentRelationship(s.thread).native && terminalTransient(s.turns)
          && s.thread.status?.type !== 'active' && !config.excludedThreadIds.includes(id)) {
        const noticeKey = parentNoticeKey(id, s.turns[0].id, 'native-failure');
        if (store.getNotice?.(noticeKey)) {
          // Existing pending items belong to the rotating lane; rediscovery must
          // not consume the slot reserved for a genuinely new failure.
          result.parentNotice = { action: 'notice-journal-retained', key: noticeKey };
        } else {
          if (!dryRun && store.createNotice && parentRelationship(s.thread).parentId) store.createNotice(noticeKey, {
            schemaVersion: 1, key: noticeKey, childId: id, failedTurnId: s.turns[0].id, kind: 'native-failure',
            parentId: parentRelationship(s.thread).parentId, phase: 'pending-parent', createdAt: new Date(now()).toISOString() });
          result.parentNotice = await notice(s, s.turns[0].id, 'native-failure');
        }
      }
      if (eligible !== 'eligible') continue;
      const turn = s.turns[0], key = episodeKey(id, turn);
      result.errorKind = errorKind(turn.error); result.turnId = turn.id;
      if (store.exists(key) || store.existingEpisode?.(id, turn.id)) { result.action = 'episode-already-recorded'; continue; }
      if (entry.nextEligibleAt > now()) { result.action = 'backoff'; continue; }
      if (report.resumed + report.noticeStarts >= config.maxStartsPerCycle) { result.action = 'cycle-limit'; continue; }
      if (now() - started >= config.cycleBudgetMs) { result.action = 'budget-deferred'; continue; }
      const rate = await client.call('account/rateLimits/read', {}, config.requestTimeoutMs);
      if (!rateAvailable(rate)) { result.action = 'rate-unavailable'; continue; }
      if (dryRun) { result.action = 'would-resume'; continue; }
      if (store.allowed && !store.allowed(id)) { result.action = 'config-stopped'; continue; }
      let fresh = await snapshot(client, id, config.requestTimeoutMs);
      if (eligibility(fresh.thread, fresh.turns, fresh.goal, config.excludedThreadIds, recoveryPrior) !== 'eligible'
          || episodeKey(id, fresh.turns[0]) !== key || !sameIdentity(s.thread, fresh.thread)
          || goalIdentity(s.goal) !== goalIdentity(fresh.goal) || s.goal?.updatedAt !== fresh.goal?.updatedAt) {
        result.action = 'preflight-changed'; continue;
      }
      // Create-exclusive BEFORE thread/resume, goal/set or turn/start.
      const attempt = { schemaVersion: 1, key, threadId: id, failedTurnId: turn.id,
        errorKind: errorKind(turn.error), phase: 'prepared', createdAt: new Date(now()).toISOString(),
        errorEvidenceSha256: hash(turn.error),
        originalGoalStatus: fresh.goal?.status ?? null,
        objectiveSha256: fresh.goal ? hash(fresh.goal.objective) : null,
        goalIdentity: goalIdentity(fresh.goal), recoveryObservation: fresh.goal?.status === 'blocked' ? recoveryPrior.activeGoalObservation : null,
        usageBefore: fresh.goal ? { tokensUsed: fresh.goal.tokensUsed, timeUsedSeconds: fresh.goal.timeUsedSeconds } : null,
        identity: { cwd: fresh.thread.cwd, model: fresh.thread.model, modelProvider: fresh.thread.modelProvider,
          reasoningEffort: fresh.thread.reasoningEffort } };
      store.create(key, attempt);
      state.threads[id] = { ...entry, count: (entry.count ?? 0) + 1, key,
        nextEligibleAt: now() + backoffMs((entry.count ?? 0) + 1) };
      store.saveState(state);
      try {
        if (store.allowed && !store.allowed(id)) {
          attempt.phase = 'config-stopped'; store.update(key, attempt); result.action = attempt.phase; continue;
        }
        attempt.phase = 'session-dispatching'; store.update(key, attempt);
        const restored = (await client.call('thread/resume', { threadId: id, excludeTurns: true }, config.requestTimeoutMs)).thread;
        if (!sameIdentity(s.thread, restored)) {
          attempt.phase = 'identity-drift-no-start'; store.update(key, attempt); result.action = attempt.phase; continue;
        }
        fresh = await snapshot(client, id, config.requestTimeoutMs);
        if (eligibility(fresh.thread, fresh.turns, fresh.goal, config.excludedThreadIds, recoveryPrior) !== 'eligible'
            || episodeKey(id, fresh.turns[0]) !== key || !sameIdentity(s.thread, fresh.thread)
            || goalIdentity(fresh.goal) !== attempt.goalIdentity || s.goal?.updatedAt !== fresh.goal?.updatedAt) {
          attempt.phase = 'changed-after-session'; store.update(key, attempt); result.action = attempt.phase; continue;
        }
        if (fresh.goal?.status === 'blocked') {
          if (store.allowed && !store.allowed(id)) {
            attempt.phase = 'config-stopped'; store.update(key, attempt); result.action = attempt.phase; continue;
          }
          attempt.phase = 'goal-dispatching'; store.update(key, attempt);
          const goalReceipt = await client.call('thread/goal/set', { threadId: id, status: 'active' }, config.requestTimeoutMs);
          if (goalReceipt.goal?.status !== 'active' || goalIdentity(goalReceipt.goal) !== attempt.goalIdentity) throw new Error('Goal receipt mismatch');
          for (const field of ['tokensUsed', 'timeUsedSeconds']) {
            if (Number.isFinite(attempt.usageBefore[field])
                && (!Number.isFinite(goalReceipt.goal[field]) || goalReceipt.goal[field] < attempt.usageBefore[field])) throw new Error('Goal usage reset');
          }
          attempt.goalRestored = true;
          store.update(key, attempt); // Durable evidence before any later read/budget/crash.
          queueRecoveryNotice(store, attempt, now, dryRun);
          fresh = await snapshot(client, id, config.requestTimeoutMs);
          if (fresh.goal?.status !== 'active' || goalIdentity(fresh.goal) !== attempt.goalIdentity || !sameIdentity(s.thread, fresh.thread)) {
            throw new Error('Goal readback mismatch');
          }
          if (fresh.turns.some(t => t.status === 'inProgress') || fresh.thread.status?.type === 'active') {
            attempt.phase = 'active-after-goal-resume'; store.update(key, attempt);
            const active = fresh.turns.find(t => t.status === 'inProgress');
            attempt.observedActiveTurnId = active?.id ?? null;
            store.update(key, attempt);
            if (active) report.resumed++; result.action = attempt.phase; continue;
          }
        }
        // Recheck races and intentional stops after goal restoration.
        fresh = await snapshot(client, id, config.requestTimeoutMs);
        if (eligibility(fresh.thread, fresh.turns, fresh.goal, config.excludedThreadIds, recoveryPrior) !== 'eligible'
            || episodeKey(id, fresh.turns[0]) !== key || !sameIdentity(s.thread, fresh.thread)
            || goalIdentity(fresh.goal) !== attempt.goalIdentity) {
          attempt.phase = 'changed-before-start'; store.update(key, attempt); result.action = attempt.phase; continue;
        }
        attempt.phase = 'turn-dispatching'; store.update(key, attempt);
        if (store.allowed && !store.allowed(id)) {
          attempt.phase = 'config-stopped'; store.update(key, attempt); result.action = attempt.phase; continue;
        }
        const [method, params] = deliveryFor(id, null, message);
        params.clientUserMessageId = 'system-error-recovery:' + key;
        const response = await client.call(method, params, config.requestTimeoutMs);
        if (!response.turn?.id) throw new Error('Missing accepted turn identity');
        attempt.phase = 'accepted'; attempt.acceptedTurnId = response.turn.id;
        store.update(key, attempt); report.resumed++; result.action = 'accepted';
        queueRecoveryNotice(store, attempt, now, dryRun);
        try {
          const after = await snapshot(client, id, config.requestTimeoutMs);
          attempt.readback = sameIdentity(s.thread, after.thread) && goalIdentity(after.goal) === attempt.goalIdentity
            && after.turns.some(t => t.id === response.turn.id) ? 'verified' : 'changed-or-not-visible';
        } catch { attempt.readback = 'unavailable'; }
        store.update(key, attempt); result.readback = attempt.readback;
      } catch {
        attempt.phase = 'unknown-no-resend'; store.update(key, attempt); result.action = attempt.phase;
      } finally {
        if (attempt.acceptedTurnId || attempt.goalRestored) {
          try { result.parentNotice = await notice(s, turn.id, 'recovery'); }
          catch { result.parentNotice = { action: 'notice-failed-recovery-retained' }; }
        }
      }
    }
    if (!dryRun) store.saveState(state);
  }
  // Use an otherwise unused new-notice slot without resetting the rotation cursor.
  await drainPending(Math.max(0, noticeLimit - report.parentNoticeAttempts));
  report.scanDeferred = state.scan.pendingIds.length;
  report.goalRecoveryPolicy = 'Previously observed active same goal/inProgress turn -> exact transient failed same turn and blocked. Temporal causal evidence authorized by PO; manual simultaneous block remains an inference limitation.';
  report.finishedAt = new Date(now()).toISOString();
  return report;
}

export async function runOnce(directory = defaultDirectory, dryRun = false) {
  fs.mkdirSync(path.join(directory, 'attempts'), { recursive: true });
  fs.mkdirSync(path.join(directory, 'parent-notices'), { recursive: true });
  const lock = path.join(directory, 'cycle.lock'), repair = path.join(directory, 'cycle-repair.lock');
  const token = crypto.randomUUID();
  if (fs.existsSync(repair)) return { action: 'lock-repair-owner-unconfirmed' };
  try { exclusive(lock, { pid: process.pid, token, startedAt: Date.now() }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const owner = readJson(lock);
    if (!Number.isInteger(owner.pid) || owner.pid <= 0) return { action: 'lock-owner-unconfirmed' };
    try { process.kill(owner.pid, 0); return { action: 'another-cycle-running' }; }
    catch (probe) {
      if (probe.code !== 'ESRCH') return { action: 'lock-owner-unconfirmed' };
      try { exclusive(repair, { pid: process.pid, token }); }
      catch (claim) { if (claim.code === 'EEXIST') return { action: 'lock-repair-running' }; throw claim; }
      try {
        if (readJson(lock).token !== owner.token) return { action: 'lock-owner-changed' };
        fs.renameSync(lock, path.join(directory, 'stale-lock-' + crypto.randomUUID() + '.json'));
        return { action: 'stale-lock-quarantined-next-cycle' };
      } finally { fs.unlinkSync(repair); }
    }
  }
  let client, stage = 'config';
  try {
    const config = validateConfig(readJson(path.join(directory, 'config.json')));
    if (!config.enabled) return { disabled: true };
    const stateFile = path.join(directory, 'state.json');
    const state = fs.existsSync(stateFile) ? readJson(stateFile) : { schemaVersion: 1, threads: {} };
    // Forward migration: old error-dependent keys still fence their original thread/turn.
    // Do not rewrite/delete old bytes. Malformed journals fail closed before any mutation.
    const existingEpisodes = new Set();
    const recoveryByEpisode = new Map();
    for (const name of fs.readdirSync(path.join(directory, 'attempts'))) {
      if (!name.endsWith('.json')) continue;
      const prior = readJson(path.join(directory, 'attempts', name));
      if (prior.schemaVersion !== 1 || typeof prior.threadId !== 'string' || !prior.threadId
          || typeof prior.failedTurnId !== 'string' || !prior.failedTurnId
          || name !== prior.key + '.json') throw new Error('Invalid recovery journal');
      existingEpisodes.add(JSON.stringify([prior.threadId, prior.failedTurnId]));
      recoveryByEpisode.set(JSON.stringify([prior.threadId, prior.failedTurnId]), prior);
    }
    const notices = new Map();
    for (const name of fs.readdirSync(path.join(directory, 'parent-notices'))) {
      if (!name.endsWith('.json')) continue;
      const prior = readJson(path.join(directory, 'parent-notices', name));
      if (prior.schemaVersion !== 1 || name !== prior.key + '.json'
          || prior.key !== parentNoticeKey(prior.childId, prior.failedTurnId, prior.kind)
          || !['native-failure', 'recovery'].includes(prior.kind)) throw new Error('Invalid parent notice journal');
      notices.set(prior.key, prior);
    }
    const store = {
      exists: key => fs.existsSync(path.join(directory, 'attempts', key + '.json')),
      existingEpisode: (id, turn) => existingEpisodes.has(JSON.stringify([id, turn])),
      getRecovery: (id, turn) => recoveryByEpisode.get(JSON.stringify([id, turn])),
      recoveryRecords: () => [...recoveryByEpisode.values()].filter(x => x.acceptedTurnId || x.goalRestored === true),
      create: (key, value) => {
        exclusive(path.join(directory, 'attempts', key + '.json'), value);
        existingEpisodes.add(JSON.stringify([value.threadId, value.failedTurnId]));
        recoveryByEpisode.set(JSON.stringify([value.threadId, value.failedTurnId]), value);
      },
      update: (key, value) => {
        saveJson(path.join(directory, 'attempts', key + '.json'), value);
        recoveryByEpisode.set(JSON.stringify([value.threadId, value.failedTurnId]), value);
      },
      getNotice: key => notices.get(key),
      createNotice: (key, value) => { exclusive(path.join(directory, 'parent-notices', key + '.json'), value); notices.set(key, value); },
      updateNotice: (key, value) => { saveJson(path.join(directory, 'parent-notices', key + '.json'), value); notices.set(key, value); },
      pendingNotices: () => [...notices.values()].filter(x => ['pending-parent', 'pending-read', 'pending-rate', 'pending-limit'].includes(x.phase)),
      saveState: value => saveJson(stateFile, value),
      allowed: id => {
        const current = validateConfig(readJson(path.join(directory, 'config.json')));
        return current.enabled && !current.excludedThreadIds.includes(id);
      },
    };
    stage = 'connect'; client = await connectCanonical({ requestTimeoutMs: config.requestTimeoutMs });
    const call = client.call.bind(client);
    client.call = async (method, params, timeout) => {
      try { return await call(method, params, timeout); }
      catch (error) { error.recoveryMethod = method; throw error; }
    };
    stage = 'cycle';
    const report = await runCycle(client, config, state, store, Date.now, dryRun);
    saveJson(path.join(directory, dryRun ? 'dry-run.json' : 'last-cycle.json'), report);
    return report;
  } catch (error) {
    const report = { failedAt: new Date().toISOString(), action: 'cycle-failed-no-blind-resend', stage,
      method: error.recoveryMethod ?? null,
      failureCategory: /timed out/.test(error.message) ? 'timeout' : 'read-or-local-state-failure' };
    saveJson(path.join(directory, dryRun ? 'dry-run.json' : 'last-cycle.json'), report);
    return report;
  } finally { client?.close(); if (fs.existsSync(lock) && readJson(lock).token === token) fs.unlinkSync(lock); }
}
export function status(directory = defaultDirectory) {
  const get = name => fs.existsSync(path.join(directory, name)) ? readJson(path.join(directory, name)) : null;
  return { config: get('config.json'), lastCycle: get('last-cycle.json'), dryRun: get('dry-run.json'),
    pendingCount: get('state.json')?.scan?.pendingIds?.length ?? 0, lock: get('cycle.lock'),
    attemptCount: fs.existsSync(path.join(directory, 'attempts')) ? fs.readdirSync(path.join(directory, 'attempts')).filter(x => x.endsWith('.json')).length : 0,
    parentNoticeCount: fs.existsSync(path.join(directory, 'parent-notices')) ? fs.readdirSync(path.join(directory, 'parent-notices')).filter(x => x.endsWith('.json')).length : 0 };
}
export function setEnabled(directory, enabled) {
  const config = validateConfig(readJson(path.join(directory, 'config.json')));
  config.enabled = enabled; saveJson(path.join(directory, 'config.json'), config); return { enabled };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), command = args[0] ?? 'run';
  const directory = args.find((_, i) => args[i - 1] === '--directory') ?? defaultDirectory;
  const report = command === 'status' ? status(directory)
    : command === 'stop' ? setEnabled(directory, false)
      : command === 'enable' ? setEnabled(directory, true)
        : ['run', 'dry-run'].includes(command) ? await runOnce(directory, command === 'dry-run')
          : (() => { throw new Error('Expected run, dry-run, status, stop or enable'); })();
  console.log(JSON.stringify(report));
  if (report.action === 'cycle-failed-no-blind-resend') process.exitCode = 1;
}
