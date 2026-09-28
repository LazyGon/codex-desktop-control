import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { AppServerClient } from '../src/app-server-client.mjs';

test('App Server initialization is acknowledged before subsequent requests', async () => {
  const server = new WebSocketServer({host:'127.0.0.1',port:0});
  await once(server,'listening');
  const observed = [];
  server.on('connection',socket => socket.on('message',bytes => {
    const message = JSON.parse(String(bytes));
    observed.push(message.method);
    if(message.method === 'initialize') socket.send(JSON.stringify({id:message.id,result:{}}));
    if(message.method === 'thread/list') socket.send(JSON.stringify({id:message.id,result:{data:[]}}));
  }));
  const client = new AppServerClient(`ws://127.0.0.1:${server.address().port}`,{requestTimeoutMs:2000});
  try {
    await client.connect();
    await client.call('thread/list',{limit:1});
    assert.deepEqual(observed,['initialize','initialized','thread/list']);
  } finally {
    client.close();
    await new Promise(resolve=>server.close(resolve));
  }
});
