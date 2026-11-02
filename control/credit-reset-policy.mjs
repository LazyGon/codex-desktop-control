import crypto from 'node:crypto';

export function accountHash(accountId) {
  return typeof accountId === 'string' && accountId
    ? crypto.createHash('sha256').update(accountId).digest('hex') : null;
}
export function validateCreditPolicy(policy) {
  if (!policy || typeof policy.enabled !== 'boolean' || !/^[0-9a-f-]{36}$/i.test(policy.authorizationId ?? '')
      || !/^[0-9a-f]{64}$/.test(policy.accountHash ?? '') || typeof policy.creditId !== 'string' || !policy.creditId
      || !Number.isSafeInteger(policy.balanceThreshold) || policy.balanceThreshold < 0
      || !Array.isArray(policy.paidRecoveryThreadIds) || policy.paidRecoveryThreadIds.some(id => typeof id !== 'string' || !id)) {
    throw new Error('Invalid credit reset policy');
  }
  return policy;
}
export function creditBalance(rate) {
  const credits = rate?.rateLimits?.credits;
  const raw = credits?.balance;
  if (!credits || credits.unlimited !== false || typeof raw !== 'string' || !/^\d+(?:\.\d+)?$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value <= Number.MAX_SAFE_INTEGER ? value : null;
}
function accountMatches(rate, policy) { return accountHash(rate?.accountId) === policy.accountHash; }
function spendBlocked(rate) {
  return [rate?.rateLimits, ...Object.values(rate?.rateLimitsByLimitId ?? {})]
    .some(bucket => bucket?.spendControlReached === true);
}
function exhausted(rate) {
  const b = rate?.rateLimits;
  return rate?.ordinaryUsageAllowed === false && b?.limitId === 'codex'
    && b.rateLimitReachedType === 'rate_limit_reached'
    && [b.primary,b.secondary].some(w => Number.isFinite(w?.usedPercent) && w.usedPercent >= 100);
}
export function paidRecoveryAvailable(rate, policy, threadId) {
  if (!policy) return false;
  validateCreditPolicy(policy);
  const balance = creditBalance(rate);
  return policy.enabled && policy.paidRecoveryThreadIds.includes(threadId) && accountMatches(rate, policy)
    && exhausted(rate) && !spendBlocked(rate) && rate.rateLimits.credits.hasCredits === true
    && balance !== null && balance > policy.balanceThreshold;
}
function sameAuthorization(a, b) {
  return b?.enabled === true && a.authorizationId === b.authorizationId && a.accountHash === b.accountHash
    && a.creditId === b.creditId && a.balanceThreshold === b.balanceThreshold;
}
function windowIdentity(rate) {
  const b = rate.rateLimits;
  return JSON.stringify([b.limitId,b.primary?.resetsAt ?? null,b.secondary?.resetsAt ?? null]);
}
export async function manageCreditReset(client, policy, store, currentPolicy = () => policy, now = Date.now, dryRun = false) {
  validateCreditPolicy(policy);
  if (!policy.enabled) return { action:'disabled' };
  const records = store.records();
  // A dispatch with no confirmed outcome is never replaced by another reset attempt.
  if (records.some(r => r.accountHash === policy.accountHash && ['prepared','dispatching','unknown-no-resend'].includes(r.phase))) {
    return { action:'unknown-no-resend' };
  }
  if (records.some(r => r.authorizationId === policy.authorizationId && ['redeemed','already-redeemed'].includes(r.phase))) {
    return { action:'completed-one-reset' };
  }
  const rate = await client.call('account/rateLimits/read', {}, null);
  if (!accountMatches(rate, policy)) return { action:'account-mismatch' };
  const balance = creditBalance(rate);
  if (balance === null) return { action:'balance-unconfirmed' };
  if (balance > policy.balanceThreshold) return { action:'holding-above-threshold' };
  if (!exhausted(rate)) return { action:'included-usage-not-exhausted' };
  if (spendBlocked(rate)) return { action:'spend-control-protected' };
  const details = rate.rateLimitResetCredits?.credits;
  if (!Array.isArray(details)) return { action:'reset-details-unavailable' };
  const credit = details.find(c => c.id === policy.creditId && c.status === 'available');
  if (!credit) return { action:'selected-reset-unavailable' };
  if (credit.resetType !== 'codexRateLimits' || (credit.expiresAt !== null
      && (!Number.isFinite(credit.expiresAt) || credit.expiresAt * 1000 <= now()))) return { action:'selected-reset-expired-or-unconfirmed' };
  const window = windowIdentity(rate);
  if (records.some(r => r.authorizationId === policy.authorizationId && ['nothing-to-reset','no-credit'].includes(r.phase)
      && r.windowIdentity === window)) return { action:'waiting-for-new-quota-window' };
  if (dryRun) return { action:'would-use-one-reset' };
  if (!sameAuthorization(policy, currentPolicy())) return { action:'authorization-changed' };
  const record = { schemaVersion:1, authorizationId:policy.authorizationId, accountHash:policy.accountHash,
    creditId:policy.creditId, idempotencyKey:crypto.randomUUID(), phase:'prepared',
    balanceThreshold:policy.balanceThreshold, windowIdentity:window, createdAt:new Date(now()).toISOString() };
  store.claim(record);
  if (!sameAuthorization(policy, currentPolicy())) {
    record.phase='cancelled-before-dispatch';store.update(record);return {action:record.phase};
  }
  record.phase='dispatching';store.update(record);
  try {
    const receipt = await client.call('account/rateLimitResetCredit/consume',
      {idempotencyKey:record.idempotencyKey,creditId:record.creditId},null);
    const phase = {reset:'redeemed',alreadyRedeemed:'already-redeemed',nothingToReset:'nothing-to-reset',noCredit:'no-credit'}[receipt?.outcome];
    if (!phase) throw new Error('Unconfirmed reset receipt');
    record.phase=phase;store.update(record);
    const result={action:phase};
    if (['redeemed','already-redeemed'].includes(phase)) {
      try { const after=await client.call('account/rateLimits/read',{},null);
        result.readback=accountMatches(after,policy)&&after.ordinaryUsageAllowed===true?'ordinary-usage-available':'not-yet-confirmed';
      } catch {result.readback='unavailable';}
    }
    return result;
  } catch {
    record.phase='unknown-no-resend';store.update(record);
    return {action:record.phase};
  }
}
