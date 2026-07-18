import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer } from 'ws';
import { AppServerClient } from '../src/app-server-client.mjs';

test('AppServerClient handles responses, notifications, and server requests', async (context) => {
  const server = new WebSocketServer({ port: 0 });
  await new Promise((resolve) => server.once('listening', resolve));
  const address = server.address();
  const url = `ws://127.0.0.1:${address.port}`;
  let peer;
  let serverResponseResolve;
  const serverResponse = new Promise((resolve) => { serverResponseResolve = resolve; });

  server.on('connection', (socket) => {
    peer = socket;
    socket.on('message', (data) => {
      const message = JSON.parse(data.toString());
      if (message.method === 'initialize') {
        socket.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { userAgent: 'mock' } }));
      } else if (message.method === 'thread/list') {
        socket.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { data: [{ id: 'thread-1' }] } }));
      } else if (!message.method && message.id === 'server-1') {
        serverResponseResolve(message);
      }
    });
  });

  const client = new AppServerClient(url);
  context.after(() => {
    client.close();
    server.close();
  });
  await client.connect();
  const listed = await client.call('thread/list', { limit: 1 });
  assert.equal(listed.data[0].id, 'thread-1');

  const notification = new Promise((resolve) => client.once('notification', resolve));
  peer.send(JSON.stringify({ jsonrpc: '2.0', method: 'turn/started', params: { threadId: 'thread-1' } }));
  assert.equal((await notification).method, 'turn/started');

  const request = new Promise((resolve) => client.once('request', resolve));
  peer.send(JSON.stringify({ jsonrpc: '2.0', id: 'server-1', method: 'item/fileChange/requestApproval', params: { threadId: 'thread-1' } }));
  const received = await request;
  assert.equal(received.id, 'server-1');
  client.respond(received.id, { decision: 'accept' });
  assert.deepEqual(await serverResponse, { jsonrpc: '2.0', id: 'server-1', result: { decision: 'accept' } });
});
