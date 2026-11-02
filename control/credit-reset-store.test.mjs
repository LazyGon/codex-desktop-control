import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { creditResetStore } from './credit-reset-store.mjs';
import { manageCreditReset } from './credit-reset-policy.mjs';

const accountId='persisted-account';
const authorizationId='dd283410-f996-4b2a-b0d7-fc0f4d77c49b';
const accountHash=crypto.createHash('sha256').update(accountId).digest('hex');
const policy={ enabled:true, authorizationId, accountHash, creditId:'ticket-one', balanceThreshold:10000,
  paidRecoveryThreadIds:['paid-task'] };
const rate={ accountId, ordinaryUsageAllowed:false, rateLimits:{ limitId:'codex',
  rateLimitReachedType:'rate_limit_reached', primary:{ usedPercent:100, resetsAt:2000000000 }, secondary:null,
  spendControlReached:false, credits:{ hasCredits:true, unlimited:false, balance:'10000' } },
  rateLimitResetCredits:{ credits:[{ id:'ticket-one', status:'available', resetType:'codexRateLimits', expiresAt:2000000000 }] } };
function tempStore(t) {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'credit-reset-test-'));
  t.after(() => fs.rmSync(directory,{ recursive:true, force:true }));
  return { directory, store:creditResetStore(directory) };
}
const claim = (key, phase='prepared') => ({ schemaVersion:1, idempotencyKey:key,
  authorizationId, accountHash, creditId:'ticket-one', balanceThreshold:10000,
  windowIdentity:'["codex",2000000000,null]', phase, createdAt:'2026-11-02T00:00:00.000Z' });

test('claim persists across reopen and duplicate idempotency key cannot overwrite it', t => {
  const { directory,store }=tempStore(t), key=crypto.randomUUID();
  store.claim(claim(key));
  assert.throws(() => store.claim(claim(key,'redeemed')));
  assert.deepEqual(creditResetStore(directory).records(),[claim(key)]);
  store.update(claim(key,'dispatching'));
  assert.deepEqual(creditResetStore(directory).records(),[claim(key,'dispatching')]);
});

test('restart after an uncertain consume cannot send another redemption', async t => {
  const { directory,store }=tempStore(t);
  let sends=0;
  const client={ async call(method) { if (method === 'account/rateLimits/read') return structuredClone(rate);
    sends++; throw new Error('Response lost after send'); } };
  assert.equal((await manageCreditReset(client,policy,store,undefined,()=>1000000000000)).action,'unknown-no-resend');
  const reopened=creditResetStore(directory);
  assert.equal(reopened.records().length,1);
  assert.equal(reopened.records()[0].phase,'unknown-no-resend');
  assert.equal((await manageCreditReset(client,policy,reopened)).action,'unknown-no-resend');
  assert.equal(sends,1);
});

test('malformed persisted journal fails closed before any account call', async t => {
  const { directory,store }=tempStore(t);
  fs.writeFileSync(path.join(directory,'credit-resets','damaged.json'),'{"phase":');
  let calls=0;
  await assert.rejects(manageCreditReset({ async call() { calls++; return rate; } },policy,store));
  assert.equal(calls,0);
});

test('a response journal without its quota-window identity cannot permit another redemption', async t => {
  const { directory,store }=tempStore(t), key=crypto.randomUUID();
  const partial=claim(key,'no-credit');
  delete partial.windowIdentity;
  fs.writeFileSync(path.join(directory,'credit-resets',key+'.json'),JSON.stringify(partial));
  let calls=0;
  await assert.rejects(manageCreditReset({ async call() { calls++; return structuredClone(rate); } },policy,store));
  assert.equal(calls,0);
});
