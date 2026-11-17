import test from 'node:test';
import assert from 'node:assert/strict';
import {restoreRecordedPause,assertRecordedPause} from './paused-goal-continuation.mjs';

const paused={threadId:'owner',objective:'Finish the original work',status:'paused',tokenBudget:10000,tokensUsed:700,timeUsedSeconds:80,createdAt:10,updatedAt:50};
function fixture(change={}) {
  let goal={...paused,...change};
  const calls=[];
  return {calls,client:{async call(method,args) {
    calls.push({method,args});
    if(method==='thread/goal/get')return {goal:{...goal}};
    if(method==='thread/turns/list')return {data:[{id:'saved-turn',status:'completed'}]};
    if(method==='thread/goal/set'){goal={...goal,status:'active',updatedAt:60};return {goal};}
    throw new Error('Unexpected operation');
  }}};
}
test('restore only status and preserve the original objective, budget and accounting',async()=>{
  const f=fixture();let reserved=false;
  const goal=await restoreRecordedPause(f.client,{threadId:'owner',turnId:'saved-turn',goal:paused},()=>{reserved=true;});
  assert.equal(reserved,true);
  assert.equal(goal.status,'active');assert.equal(goal.objective,paused.objective);
  assert.equal(goal.tokenBudget,10000);assert.equal(goal.tokensUsed,700);
  assert.deepEqual(f.calls.filter(x=>x.method==='thread/goal/set'),[{method:'thread/goal/set',args:{threadId:'owner',status:'active'}}]);
});
for(const [name,change] of Object.entries({newerPause:{updatedAt:51},changedObjective:{objective:'Other work'},changedBudget:{tokenBudget:10001},canceled:{status:'complete'},alreadyActive:{status:'active'},resetUsage:{tokensUsed:0}})) {
  test('do not override '+name,async()=>{
    const f=fixture(change);
    await assert.rejects(restoreRecordedPause(f.client,{threadId:'owner',turnId:'saved-turn',goal:paused}));
    assert.equal(f.calls.some(x=>x.method==='thread/goal/set'),false);
  });
}
test('an uncertain goal mutation is never repeated',async()=>{
  let sets=0;
  const client={async call(method){if(method==='thread/goal/get')return {goal:paused};if(method==='thread/turns/list')return {data:[{id:'saved-turn',status:'completed'}]};sets++;throw new Error('connection lost');}};
  await assert.rejects(restoreRecordedPause(client,{threadId:'owner',turnId:'saved-turn',goal:paused}),/connection lost/);
  assert.equal(sets,1);
});

test('a user interruption or a newer turn prevents both restart admission and restoration',()=>{
  const record={threadId:'owner',turnId:'saved-turn',goal:paused};
  assert.doesNotThrow(()=>assertRecordedPause(record,paused,{id:'saved-turn',status:'completed'}));
  assert.throws(()=>assertRecordedPause(record,paused,{id:'saved-turn',status:'interrupted'}),/interrupted/);
  assert.throws(()=>assertRecordedPause(record,paused,{id:'newer-user-turn',status:'completed'}),/changed/);
});

test('failure callback can restore the same still-running source but cannot override a user stop or newer turn',async()=>{
  const record={threadId:'owner',turnId:'saved-turn',goal:paused};
  const active={id:'saved-turn',status:'inProgress'};
  assert.throws(()=>assertRecordedPause(record,paused,active),/changed or was interrupted/);
  assert.doesNotThrow(()=>assertRecordedPause(record,paused,active,{allowSourceInProgress:true}));
  assert.throws(()=>assertRecordedPause(record,paused,{id:'saved-turn',status:'interrupted'},{allowSourceInProgress:true}));
  assert.throws(()=>assertRecordedPause(record,paused,{id:'new-user-turn',status:'inProgress'},{allowSourceInProgress:true}));
  const f=fixture();const client={call:(method,args)=>method==='thread/turns/list'?Promise.resolve({data:[active]}):f.client.call(method,args)};
  assert.equal((await restoreRecordedPause(client,record,()=>{},{allowSourceInProgress:true})).status,'active');
});
