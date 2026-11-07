import assert from 'node:assert/strict';
import test from 'node:test';
import { DesktopNavigation } from '../src/desktop-navigation.mjs';

test('Desktop navigation uses its own ephemeral context without starting a turn', async () => {
  const calls = [];
  const client = { async call(method, params) {
    calls.push([method, params]);
    if (method === 'thread/start') return { thread: { id: 'context', ephemeral: true, path: null } };
    if (method === 'mcpServerStatus/list') {
      return { data: [{ name: 'codex_app', tools: { navigate_to_codex_page: {} } }] };
    }
    if (method === 'mcpServer/tool/call') {
      return params.arguments.threadId === 'cold-task'
        ? { content: [{ type: 'text', text: '{"navigated":true}' }] }
        : { isError: true, structuredContent: { navigated: true } };
    }
    throw new Error('Unexpected RPC');
  } };
  const navigator = new DesktopNavigation();
  assert.equal(await (await navigator.prepare(client))('cold-task'), true);
  assert.equal(await (await navigator.prepare(client))('other-task'), false);
  assert.deepEqual(calls, [
    ['thread/start', { ephemeral: true }],
    ['mcpServerStatus/list', { threadId: 'context', serverName: 'codex_app', detail: 'toolsAndAuthOnly' }],
    ['mcpServer/tool/call', {
      threadId: 'context', server: 'codex_app', tool: 'navigate_to_codex_page', arguments: { threadId: 'cold-task' },
    }],
    ['mcpServer/tool/call', {
      threadId: 'context', server: 'codex_app', tool: 'navigate_to_codex_page', arguments: { threadId: 'other-task' },
    }],
  ]);
});

test('an uncertain context creation is not resent on the same connection', async () => {
  let created = false;
  const client = { async call(method) {
    assert.equal(method, 'thread/start');
    assert.equal(created, false);
    created = true;
    throw new Error('No receipt for context creation');
  } };
  const navigator = new DesktopNavigation();
  await assert.rejects(navigator.prepare(client), /No receipt/);
  await assert.rejects(navigator.prepare(client), /No receipt/);
});
