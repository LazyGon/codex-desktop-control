import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { accountHash, creditBalance, paidRecoveryAvailable, manageCreditReset } from './credit-reset-policy.mjs';

const accountId = 'account-owned-by-user';
const authorizationId = '8a0c7c39-104a-4e20-b6c7-195edfab79b1';
const creditId = 'oldest-selected-ticket';
const policy = () => ({ enabled:true, authorizationId, accountHash:crypto.createHash('sha256').update(accountId).digest('hex'),
  creditId, balanceThreshold:10000, paidRecoveryThreadIds:['authorized-task'] });
const rate = (balance = '10000') => ({ accountId, ordinaryUsageAllowed:false,
  rateLimits:{ limitId:'codex', rateLimitReachedType:'rate_limit_reached',
    primary:{ usedPercent:100, resetsAt:2000000000 }, secondary:null, spendControlReached:false,
    credits:{ hasCredits:true, unlimited:false, balance } },
  rateLimitResetCredits:{ credits:[
    { id:creditId, status:'available', resetType:'codexRateLimits', expiresAt:2000000000 },
    { id:'newer-ticket', status:'available', resetType:'codexRateLimits', expiresAt:2100000000 },
  ] } });
function memoryStore(initial = []) {
  const items = structuredClone(initial);
  return { items, records:() => structuredClone(items), claim(record) { items.push(structuredClone(record)); },
    update(record) { const index=items.findIndex(item => item.idempotencyKey === record.idempotencyKey);
      assert.notEqual(index,-1); items[index]=structuredClone(record); } };
}
test('account hash and balance parsing bind to the actual account and confirmed finite credit balance', () => {
  assert.equal(accountHash(accountId), crypto.createHash('sha256').update(accountId).digest('hex'));
  assert.equal(accountHash(''), null);
  for (const [input, expected] of [['10000.01',10000.01],['10000',10000],['9999.99',9999.99],
    ['',null],[' ',null],['NaN',null],['1e4',null],['-1',null],['Infinity',null]]) {
    assert.equal(creditBalance(rate(input)), expected, input);
  }
  assert.equal(creditBalance({ ...rate(), rateLimits:{ ...rate().rateLimits, credits:{ hasCredits:true, unlimited:true, balance:'10000' } } }), null);
  assert.equal(creditBalance({ ...rate(), rateLimits:{ ...rate().rateLimits, credits:{ hasCredits:true, unlimited:false } } }), null);
});

test('paid recovery requires authorized task, actual account, exhausted included Codex quota and confirmed credits above threshold', () => {
  const p=policy();
  assert.equal(paidRecoveryAvailable(rate('10000.01'),p,'authorized-task'),true);
  for (const altered of [rate('10000'),rate('9999.99'),{ ...rate('10000.01'), accountId:'another-account' },
    { ...rate('10000.01'), ordinaryUsageAllowed:true },
    { ...rate('10000.01'), rateLimits:{ ...rate().rateLimits, primary:{ usedPercent:99, resetsAt:2000000000 } } },
    { ...rate('10000.01'), rateLimits:{ ...rate().rateLimits, limitId:'other' } },
    { ...rate('10000.01'), rateLimits:{ ...rate().rateLimits, rateLimitReachedType:'other' } },
    { ...rate('10000.01'), rateLimits:{ ...rate().rateLimits, spendControlReached:true } },
    { ...rate('10000.01'), rateLimits:{ ...rate().rateLimits, credits:{ hasCredits:false, unlimited:false, balance:'10000.01' } } },
  ]) assert.equal(paidRecoveryAvailable(altered,p,'authorized-task'),false);
  assert.equal(paidRecoveryAvailable(rate('10000.01'),p,'other-task'),false);
  assert.equal(paidRecoveryAvailable(rate('10000.01'),{ ...p, enabled:false },'authorized-task'),false);
});

test('above-threshold, uncertain and protected states preserve both tickets', async () => {
  const changes=[
    [rate('10000.01'),'holding-above-threshold'],[rate(''),'balance-unconfirmed'],
    [{ ...rate(), accountId:'different-account' },'account-mismatch'],
    [{ ...rate(), ordinaryUsageAllowed:true },'included-usage-not-exhausted'],
    [{ ...rate(), rateLimits:{ ...rate().rateLimits, spendControlReached:true } },'spend-control-protected'],
  ];
  for (const [observed, action] of changes) {
    const store=memoryStore(), calls=[];
    const client={ async call(method) { calls.push(method); return observed; } };
    assert.equal((await manageCreditReset(client,policy(),store,undefined,()=>1000000000000)).action,action);
    assert.deepEqual(calls,['account/rateLimits/read']);
    assert.equal(store.items.length,0);
  }
});

test('disabled authorization and unavailable, mismatched or expired selected ticket never consume', async () => {
  const store=memoryStore(); let calls=0;
  const disabled={ async call() { calls++; throw new Error('No RPC is allowed'); } };
  assert.equal((await manageCreditReset(disabled,{ ...policy(), enabled:false },store)).action,'disabled');
  assert.equal(calls,0);
  for (const [details, expected] of [
    [undefined,'reset-details-unavailable'],
    [{ credits:[] },'selected-reset-unavailable'],
    [{ credits:[{ id:creditId, status:'available', resetType:'other', expiresAt:2000000000 }] },'selected-reset-expired-or-unconfirmed'],
    [{ credits:[{ id:creditId, status:'available', resetType:'codexRateLimits', expiresAt:999999999 }] },'selected-reset-expired-or-unconfirmed'],
  ]) {
    const observed={ ...rate(), rateLimitResetCredits:details }, methods=[];
    const client={ async call(method) { methods.push(method); return observed; } };
    assert.equal((await manageCreditReset(client,policy(),store,undefined,()=>1000000000000)).action,expected);
    assert.deepEqual(methods,['account/rateLimits/read']);
    assert.equal(store.items.length,0);
  }
});

test('revoked authorization before dispatch leaves an unspent terminal record', async () => {
  const store=memoryStore(), methods=[];
  const client={ async call(method) { methods.push(method); return rate(); } };
  let checks=0;
  const currentPolicy=() => ++checks === 1 ? policy() : { ...policy(), enabled:false };
  assert.equal((await manageCreditReset(client,policy(),store,currentPolicy,()=>1000000000000)).action,
    'cancelled-before-dispatch');
  assert.deepEqual(methods,['account/rateLimits/read']);
  assert.equal(store.items[0].phase,'cancelled-before-dispatch');
});

test('changed authorization before claim does not write a journal or send a reset', async () => {
  const store=memoryStore(), methods=[];
  const client={ async call(method) { methods.push(method); return rate(); } };
  assert.equal((await manageCreditReset(client,policy(),store,() => ({ ...policy(), creditId:'other-ticket' }),
    ()=>1000000000000)).action,'authorization-changed');
  assert.deepEqual(methods,['account/rateLimits/read']);
  assert.equal(store.items.length,0);
});

test('dry run leaves no claim; live redemption uses exactly the selected ticket with a persisted idempotency key', async () => {
  const store=memoryStore(), p=policy();
  const calls=[];
  const client={ async call(method,params) {
    calls.push(method);
    if (method === 'account/rateLimits/read') return calls.filter(x => x === method).length === 1 ? rate() : { ...rate(), ordinaryUsageAllowed:true };
    assert.equal(method,'account/rateLimitResetCredit/consume');
    assert.deepEqual(params,{ idempotencyKey:store.items[0].idempotencyKey, creditId });
    assert.equal(store.items[0].phase,'dispatching');
    assert.equal(store.items[0].authorizationId,authorizationId);
    assert.equal(store.items[0].accountHash,p.accountHash);
    return { outcome:'reset' };
  } };
  assert.equal((await manageCreditReset(client,p,store,undefined,()=>1000000000000,true)).action,'would-use-one-reset');
  assert.equal(store.items.length,0);
  assert.deepEqual(calls,['account/rateLimits/read']);
  calls.length=0;
  assert.deepEqual(await manageCreditReset(client,p,store,undefined,()=>1000000000000),
    { action:'redeemed', readback:'ordinary-usage-available' });
  assert.equal(store.items.length,1);
  assert.match(store.items[0].idempotencyKey,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(store.items[0].phase,'redeemed');
  calls.length=0;
  assert.equal((await manageCreditReset(client,p,store)).action,'completed-one-reset');
  assert.deepEqual(calls,[]);
});

test('unconfirmed consume outcome fences replay; accepted receipt survives readback failure', async () => {
  const uncertain=memoryStore();
  const client={ async call(method) { if (method === 'account/rateLimits/read') return rate(); throw new Error('RPC connection lost'); } };
  assert.equal((await manageCreditReset(client,policy(),uncertain,undefined,()=>1000000000000)).action,'unknown-no-resend');
  assert.equal(uncertain.items[0].phase,'unknown-no-resend');
  assert.equal((await manageCreditReset(client,policy(),uncertain)).action,'unknown-no-resend');
  const accepted=memoryStore(); let reads=0;
  const acceptedClient={ async call(method) { if (method === 'account/rateLimits/read') { if (++reads > 1) throw new Error('readback unavailable'); return rate(); }
    return { outcome:'reset' }; } };
  assert.deepEqual(await manageCreditReset(acceptedClient,policy(),accepted,undefined,()=>1000000000000),
    { action:'redeemed', readback:'unavailable' });
  assert.equal(accepted.items[0].phase,'redeemed');
});

test('unrecognized receipt and failed receipt persistence retain a no-resend fence', async () => {
  for (const { receipt, failReceiptUpdate } of [
    { receipt:{ outcome:'unexpected' }, failReceiptUpdate:false },
    { receipt:{ outcome:'reset' }, failReceiptUpdate:true },
  ]) {
    const store=memoryStore(), savedUpdate=store.update; let failed=false, sends=0;
    store.update=record => {
      if (failReceiptUpdate && record.phase === 'redeemed' && !failed) { failed=true; throw new Error('Disk write failed'); }
      savedUpdate(record);
    };
    const client={ async call(method) { if (method === 'account/rateLimits/read') return rate();
      sends++; return receipt; } };
    assert.equal((await manageCreditReset(client,policy(),store,undefined,()=>1000000000000)).action,'unknown-no-resend');
    assert.equal(store.items[0].phase,'unknown-no-resend');
    assert.equal((await manageCreditReset(client,policy(),store)).action,'unknown-no-resend');
    assert.equal(sends,1);
  }
});

test('a prior dispatch claim blocks replay, while a noCredit result waits for a changed quota window', async () => {
  for (const phase of ['prepared','dispatching','unknown-no-resend']) {
    const store=memoryStore([{ authorizationId, accountHash:policy().accountHash, phase, idempotencyKey:crypto.randomUUID() }]);
    const client={ async call() { throw new Error('No RPC is allowed'); } };
    assert.equal((await manageCreditReset(client,policy(),store)).action,'unknown-no-resend');
  }
  const store=memoryStore(), calls=[];
  let current=rate();
  const client={ async call(method) { calls.push(method); return method === 'account/rateLimits/read' ? current : { outcome:'noCredit' }; } };
  assert.equal((await manageCreditReset(client,policy(),store,undefined,()=>1000000000000)).action,'no-credit');
  calls.length=0;
  assert.equal((await manageCreditReset(client,policy(),store,undefined,()=>1000000000000)).action,'waiting-for-new-quota-window');
  assert.deepEqual(calls,['account/rateLimits/read']);
  current={ ...rate(), rateLimits:{ ...rate().rateLimits, primary:{ usedPercent:100, resetsAt:2100000000 } } };
  calls.length=0;
  assert.equal((await manageCreditReset(client,policy(),store,undefined,()=>1000000000000)).action,'no-credit');
  assert.equal(calls.filter(x => x === 'account/rateLimitResetCredit/consume').length,1);
});
