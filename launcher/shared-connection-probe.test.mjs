import test from 'node:test';
import assert from 'node:assert/strict';
import { probeSharedConnection } from './verify-shared-connection.mjs';
const fake=(unknownError=null,acceptUnknown=false)=>({
 connect:async()=>{},
 call:async(method,params)=>{
  if(method==='thread/list')return {data:[{id:'owned'}]};
  assert.equal(params.includeTurns,false);
  if(params.threadId==='owned')return {thread:{id:'owned'}};
  if(unknownError)throw new Error(unknownError);
  if(acceptUnknown)return {thread:{id:params.threadId}};
  throw new Error('thread/read: thread not found');
 }
});
test('protocol, exact local membership, and explicit unknown-ID rejection are independently checked',async()=>{
 assert.deepEqual(await probeSharedConnection(fake(),'unknown'),{initialized:true,threadListVerified:true,localMembershipVerified:true,unknownTaskIgnored:true,sampleCount:1});
});
test('a timeout or disconnected transport is not mistaken for unknown-ID rejection',async()=>{
 for(const message of ['thread/read timed out after 60000 ms.','Codex app-server disconnected (1006).'])await assert.rejects(probeSharedConnection(fake(message),'unknown'),new RegExp(message.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
 await assert.rejects(probeSharedConnection(fake(null,true),'unknown'),/unknown task was accepted/);
 assert.equal((await probeSharedConnection(fake('thread/read: thread not loaded: unknown'),'unknown')).unknownTaskIgnored,true);
});
