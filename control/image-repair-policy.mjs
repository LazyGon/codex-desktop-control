import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

export const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
export const imageEpisode = (threadId, turnId) => sha256(JSON.stringify([threadId, turnId]));
export function imageFailure(turn) {
  if (turn?.status !== 'failed' || !turn.id || !turn.error || turn.error.willRetry === true) return false;
  const info = turn.error.codexErrorInfo;
  // This is only a candidate signature, never a diagnosis of the cause.
  return (info === 'other' || info === 'badRequest'
    || info?.httpConnectionFailed?.httpStatusCode === 400)
    && /\bbad request\b/i.test(turn.error.message ?? '');
}
export function repairIdentity(thread) {
  return Object.fromEntries(['id', 'cwd', 'model', 'modelProvider', 'reasoningEffort',
    'parentThreadId', 'agentRole', 'source', 'environments'].map(k => [k, thread[k] ?? null]));
}
export function resumeSettings(result) {
  if (!result.cwd || !result.model || !result.modelProvider || !result.approvalPolicy
      || !result.sandbox || typeof result.sandbox !== 'object') throw Error('Original execution settings unavailable');
  return Object.fromEntries(['cwd', 'model', 'modelProvider', 'reasoningEffort', 'approvalPolicy',
    'approvalsReviewer', 'sandbox', 'activePermissionProfile', 'serviceTier', 'runtimeWorkspaceRoots']
    .map(k => [k, result[k] ?? null]));
}
export function imageSafety(snapshot, excluded = []) {
  const { thread, turns, goal } = snapshot;
  if (excluded.includes(thread.id)) return 'excluded';
  if (thread.archived || thread.canAcceptDirectInput !== true || thread.threadSource === 'subagent'
      || typeof thread.source === 'object') return 'not-ordinary-direct-input';
  if (!thread.id || !thread.cwd || !thread.model || !thread.modelProvider) return 'missing-identity';
  if (thread.status?.type === 'active' || turns.some(t => t.status === 'inProgress')) return 'active';
  // Archive/unarchive of goal-driven tasks can start work automatically. That
  // lifecycle has not been established safe for a history replacement.
  if (goal !== null) return 'goal-history-repair-not-supported';
  if (!imageFailure(turns[0])) return 'not-image-failure-candidate';
  return null;
}
export function checkedPin(pin) {
  if (!pin || typeof pin.file !== 'string' || !path.isAbsolute(pin.file)
      || !/^[a-f0-9]{64}$/.test(pin.sha256 ?? '') || !Number.isSafeInteger(pin.byteLength)) throw Error('Invalid evidence pin');
  const bytes = fs.readFileSync(pin.file);
  if (bytes.length !== pin.byteLength || sha256(bytes) !== pin.sha256) throw Error('Evidence changed');
  return bytes;
}
export function permitDecision(snapshot, permit, excluded = []) {
  const reason = imageSafety(snapshot, excluded);
  if (reason) return reason;
  if (!permit) return 'image-cause-unconfirmed';
  if (permit.schemaVersion !== 1 || permit.confirmedCause !== 'embedded-image-history'
      || permit.threadId !== snapshot.thread.id || permit.failedTurnId !== snapshot.turns[0].id
      || permit.errorSha256 !== sha256(JSON.stringify(snapshot.turns[0].error))
      || !isDeepStrictEqual(permit.identity, repairIdentity(snapshot.thread))) return 'confirmation-does-not-match';
  try { checkedPin(permit.evidence); } catch { return 'confirmation-evidence-unavailable'; }
  return 'confirmed-image-episode';
}
export function pinFile(file) {
  file = path.resolve(file);
  const bytes = fs.readFileSync(file);
  return { file, byteLength: bytes.length, sha256: sha256(bytes) };
}
export function exclusiveJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, 'wx');
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
}
export function confirmationPath(directory, threadId, turnId) {
  return path.join(directory, 'image-history', 'confirmations', imageEpisode(threadId, turnId) + '.json');
}
export function normalizeRollout(file) {
  return path.resolve(file.replace(/^\\\\\?\\/, ''));
}
export function rolloutUnder(file, directory, threadId) {
  const actual = normalizeRollout(file), relative = path.relative(path.resolve(directory), actual);
  if (!relative || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)
      || !path.basename(actual).endsWith('-' + threadId + '.jsonl')) throw Error('Rollout outside expected thread storage');
  return actual;
}
