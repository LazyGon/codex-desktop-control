import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {attachChannelCreateDiagnostics} from '../src/discord-rest-diagnostics.mjs';
import {REST} from '@discordjs/rest';

test('channel-create diagnostics capture safe headers without credentials, URL or body',async()=>{
  const rest=new EventEmitter();
  const events=[];
  const response={status:429,headers:new Headers({'Retry-After':'75.25','X-RateLimit-Scope':'shared','X-RateLimit-Remaining':'0'})};
  let calls=0;
  rest.options={version:'10',makeRequest:async()=>{calls++;return response;}};
  const diagnostic=attachChannelCreateDiagnostics(rest,'123',(event,details)=>events.push({event,...details}));
  const options={method:'POST',headers:{Authorization:'SECRET_TOKEN'},body:'PRIVATE_CHAT'};
  assert.equal(await rest.options.makeRequest('https://discord.com/api/v10/guilds/123/channels',options),response);
  assert.equal(calls,1);
  assert.equal(diagnostic.snapshot().retryAfterMs,75250);
  assert.equal(diagnostic.snapshot().scope,'shared');
  assert.doesNotMatch(JSON.stringify(events),/SECRET_TOKEN|PRIVATE_CHAT|https:|Authorization/);
  await rest.options.makeRequest('https://discord.com/api/v10/channels/456/messages',options);
  assert.equal(events.length,2);
  rest.emit('rateLimited',{method:'POST',majorParameter:'123',route:'/guilds/:id/channels',retryAfter:4000,global:false,url:'SECRET_URL'});
  assert.equal(diagnostic.snapshot().phase,'rate-limited');
  assert.doesNotMatch(JSON.stringify(events),/SECRET_URL/);
});

test('network failures expose only safe type/code and prevent unsafe write retries',async()=>{
  const rest=new EventEmitter();
  const failure=Object.assign(new Error('PRIVATE_ERROR_BODY'),{code:'UND_ERR_CONNECT_TIMEOUT'});
  rest.options={version:'10',makeRequest:async()=>{throw failure;}};
  const diagnostic=attachChannelCreateDiagnostics(rest,'123');
  await assert.rejects(rest.options.makeRequest('https://discord.com/api/v10/guilds/123/channels',{method:'POST'}),error=>error.name==='ChannelCreateTransportError');
  assert.deepEqual({...diagnostic.snapshot(),at:null},{at:null,phase:'network-error',errorType:'Error',errorCode:'UND_ERR_CONNECT_TIMEOUT'});
});

test('the installed REST library does not retry ambiguous channel writes',async()=>{
  for(const kind of ['timeout','server-error']){
    let calls=0;
    const rest=new REST({version:'10',makeRequest:async()=>{
      calls++;
      if(kind==='timeout')throw Object.assign(new Error('PRIVATE'),{name:'AbortError'});
      return new Response('PRIVATE_RESPONSE',{status:503});
    }}).setToken('test-only-fixture');
    attachChannelCreateDiagnostics(rest,'123');
    await assert.rejects(rest.post('/guilds/123/channels',{body:{name:'test'}}),error=>error.name==='ChannelCreateTransportError');
    assert.equal(calls,1);
  }
});
