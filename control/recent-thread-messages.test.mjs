import test from 'node:test';
import assert from 'node:assert/strict';
import { recentThreadMessages } from './recent-thread-messages.mjs';

const entry = (turnId, id, type, text = id) => ({ turnId, item: { id, type, text } });
function fixture(itemPages, turnPages) {
  const calls = [];
  return { calls, async call(method, params) {
    calls.push({method, params});
    const pages = method === 'thread/items/list' ? itemPages : turnPages;
    assert.ok(method === 'thread/items/list' || method === 'thread/turns/list');
    const response = pages[params.cursor ?? 'first'];
    assert.ok(response, `Unexpected page ${method} ${params.cursor}`);
    return response;
  }};
}

test('reads enough messages across item and turn pages, preserving phases and chronological order', async () => {
  const a = {...entry('new', 'a', 'agentMessage'), item: {...entry('new', 'a', 'agentMessage').item, phase:'commentary'}};
  const b = entry('new', 'b', 'userMessage');
  const c = entry('old', 'c', 'agentMessage');
  const client = fixture({
    first: {data:[entry('new','tool','commandExecution'),a],nextCursor:'items2'},
    items2: {data:[b,c,entry('old','discard','userMessage')],nextCursor:'unused'},
  },{
    first: {data:[{id:'empty',status:'completed'},{id:'new',status:'inProgress'}],nextCursor:'turns2'},
    turns2: {data:[{id:'old',status:'completed'}],nextCursor:null},
  });
  const result=await recentThreadMessages(client,{id:'thread',name:'name'},3);
  assert.equal(result.name,'name');
  assert.deepEqual(result.turns.map(t=>[t.id,t.status,t.items.map(i=>i.id)]),[
    ['old','completed',['c']],['new','inProgress',['b','a']],
  ]);
  assert.equal(result.turns[1].items[1].phase,'commentary');
  assert.ok(client.calls.every(c=>c.params.sortDirection==='desc'));
});

test('stops after the requested messages and avoids unrelated old history', async () => {
  const client=fixture({first:{data:[entry('one','a','agentMessage'),entry('one','b','userMessage')],nextCursor:'never'}},{first:{data:[{id:'one',status:'completed'}],nextCursor:'never'}});
  const result=await recentThreadMessages(client,{id:'thread'},1);
  assert.deepEqual(result.turns[0].items.map(i=>i.id),['a']);
});

test('empty history needs no turn read', async () => {
  const client=fixture({first:{data:[],nextCursor:null}},{});
  assert.deepEqual((await recentThreadMessages(client,{id:'thread'},2)).turns,[]);
});

test('rejects repeated item cursors rather than polling forever', async () => {
  const client=fixture({first:{data:[],nextCursor:'repeat'},repeat:{data:[],nextCursor:'repeat'}},{});
  await assert.rejects(recentThreadMessages(client,{id:'thread'},2),/repeated cursor/);
});

test('does not invent turn status when projection metadata is unavailable', async () => {
  const client=fixture({first:{data:[entry('missing','a','agentMessage')],nextCursor:null}},{first:{data:[],nextCursor:null}});
  await assert.rejects(recentThreadMessages(client,{id:'thread'},1),/metadata was unavailable/);
});
