import test from 'node:test';
import assert from 'node:assert/strict';
import {configureCreditPolicy} from './credit-reset-settings.mjs';

const rate=()=>({accountId:'abc',rateLimits:{credits:{hasCredits:true,unlimited:false,balance:'53000'}},
 rateLimitResetCredits:{availableCount:2,credits:[
  {id:'later-ticket',status:'available',resetType:'codexRateLimits',expiresAt:2100000000},
  {id:'earliest-ticket',status:'available',resetType:'codexRateLimits',expiresAt:2000000000},
 ]}});
const config=()=>({schemaVersion:1,enabled:true,excludedThreadIds:['protected-task'],maxStartsPerCycle:2,
 maxThreadsPerCycle:32,requestTimeoutMs:null,cycleBudgetMs:null});
test('configuration pins the earliest-expiring ticket without redemption and preserves other recovery settings',async()=>{
 const calls=[],before=config();let saved;
 const client={async call(method){calls.push(method);return rate();}};
 const result=await configureCreditPolicy(client,()=>before,value=>saved=value,10000,['rvm-owner'],1000000000000);
 assert.deepEqual(calls,['account/rateLimits/read']);
 assert.equal(result.balanceBand,'above-threshold');
 assert.equal(result.automaticResetLimit,1);
 assert.equal(saved.creditResetPolicy.creditId,'earliest-ticket');
 assert.equal(saved.creditResetPolicy.accountHash,'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
 assert.equal(saved.creditResetPolicy.balanceThreshold,10000);
 assert.deepEqual(saved.creditResetPolicy.paidRecoveryThreadIds,['rvm-owner']);
 assert.equal(saved.maxStartsPerCycle,2);
 assert.equal(saved.maxThreadsPerCycle,32);
 assert.deepEqual(saved.excludedThreadIds,['protected-task']);
});
test('uncertain account, balance, ticket details or existing active authorization do not alter configuration',async()=>{
 for(const change of [r=>delete r.accountId,r=>delete r.rateLimits.credits.balance,
   r=>r.rateLimitResetCredits.credits=null,r=>r.rateLimitResetCredits.credits=[]]){
  const observed=rate();change(observed);let writes=0;
  await assert.rejects(configureCreditPolicy({async call(){return observed;}},config,()=>writes++,10000,[],1000000000000));
  assert.equal(writes,0);
 }
 const before={...config(),creditResetPolicy:{enabled:true,authorizationId:'00000000-0000-4000-8000-000000000001',
  accountHash:'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  creditId:'existing',balanceThreshold:10000,paidRecoveryThreadIds:[]}};let writes=0;
 await assert.rejects(configureCreditPolicy({async call(){return rate();}},()=>before,()=>writes++,10000,[],1000000000000),/already exists/);
 assert.equal(writes,0);
});
