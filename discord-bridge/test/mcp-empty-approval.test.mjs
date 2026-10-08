import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isEmptyMcpToolApproval, emptyMcpToolApprovalResponse } from '../src/mcp-empty-approval.mjs';
import { DiscordController } from '../src/discord-controller.mjs';
import { StateStore } from '../src/state-store.mjs';

// Synthetic fixture: installed App Server form schema plus Desktop's
// codex_approval_kind=mcp_tool_call metadata. Not a captured historical request.
const approval = () => ({
  serverName: 'codex_app', threadId: 'thread-1', turnId: 'turn-1', mode: 'form',
  message: 'Allow create_thread?',
  requestedSchema: { type: 'object', properties: {}, required: [] },
  _meta: { codex_approval_kind: 'mcp_tool_call', connector_id: 'codex_app', tool_name: 'create_thread', tool_params: {} },
});

test('only explicit ordinary tool approvals with an unconstrained empty object use buttons', () => {
  assert.equal(isEmptyMcpToolApproval(approval()), true);
  assert.deepEqual(emptyMcpToolApprovalResponse(approval()), { action: 'accept', content: {} });
  const rejected = [
    { requestedSchema: undefined },
    { requestedSchema: { type: 'object' } },
    { requestedSchema: { type: 'object', properties: {}, required: ['proof'] } },
    { requestedSchema: { type: 'object', properties: {}, minProperties: 1 } },
    { requestedSchema: { type: 'object', properties: {}, allOf: [{ required: ['proof'] }] } },
    { requestedSchema: { type: 'object', properties: { approved: { type: 'boolean' } } } },
    { requestedSchema: { type: 'object', properties: [], required: [] } },
    { mode: 'openai/form' }, { mode: 'openaiForm' },
    { mode: 'openai/userVerification', challenge: 'challenge', title: 'Verify', description: 'Verify identity' },
    { mode: 'url', url: 'https://example.test/auth', elicitationId: 'auth-1' },
    { _meta: undefined }, { _meta: { codex_approval_kind: 'browser_auth' } },
    { _meta: { ...approval()._meta, 'openai/confirmation': {} } },
    { _meta: { ...approval()._meta, tool_name: '' } },
  ];
  for (const override of rejected) {
    const params = { ...approval(), ...override };
    assert.equal(isEmptyMcpToolApproval(params), false, JSON.stringify(override));
    assert.throws(() => emptyMcpToolApprovalResponse(params), /original input or verification/);
  }
});

async function harness(context) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-empty-approval-'));
  const stateStore = new StateStore(directory, 'guild-1');
  stateStore.setBinding('thread-1', { channelId: 'channel-1', name: 'Test', archived: false });
  const client = new EventEmitter(); client.user = { id: 'bot' };
  const posted = [], responses = [], errors = [];
  const channel = { send: async (payload) => { posted.push(payload); return { id: 'message-1' }; },
    messages: { fetch: async () => ({ edit: async () => {} }) } };
  client.channels = { fetch: async () => channel };
  const codex = new EventEmitter();
  codex.respondToServerRequest = (id, result) => responses.push({ id, result });
  const controller = new DiscordController({ client, codex, stateStore,
    config: { guildId: 'guild-1', authorizedUserIds: ['user-1'] }, logDir: directory });
  controller.attach();
  context.after(async () => { await controller.stop(); fs.rmSync(directory, { recursive: true, force: true }); });
  const settle = async () => { for (let i = 0; i < 12; i++) await new Promise(setImmediate); };
  const emit = async (params) => { codex.emit('serverRequest', { id: 14, method: 'mcpServer/elicitation/request', params }); await settle(); };
  const click = async (customId, userId = 'user-1') => {
    client.emit('interactionCreate', { customId, guildId: 'guild-1', channelId: 'channel-1', user: { id: userId },
      isAutocomplete: () => false, isChatInputCommand: () => false, isStringSelectMenu: () => false,
      isButton: () => true, isModalSubmit: () => false, deferUpdate: async () => {},
      editReply: async () => {}, reply: async (value) => errors.push(value) });
    await settle();
  };
  return { posted, responses, errors, emit, click, controller };
}

test('Discord empty approval posts buttons, never auto-accepts, and returns content after authorized click', async (context) => {
  const h = await harness(context); await h.emit(approval());
  const buttons = h.posted[0].components[0].toJSON().components;
  assert.deepEqual(buttons.map((b) => b.label), ['今回のみ許可', '拒否', 'キャンセル']);
  assert.equal(h.responses.length, 0);
  await h.click(buttons[0].custom_id, 'other-user'); assert.equal(h.responses.length, 0);
  await h.click(buttons[0].custom_id);
  assert.deepEqual(h.responses, [{ id: 14, result: { action: 'accept', content: {} } }]);
});

test('Discord input form keeps input button and forged empty-accept is rejected', async (context) => {
  const h = await harness(context);
  await h.emit({ ...approval(), requestedSchema: { type: 'object', properties: { proof: { type: 'string' } }, required: ['proof'] } });
  const button = h.posted[0].components[0].toJSON().components[0];
  assert.equal(button.label, '回答を入力');
  await h.click(button.custom_id.replace(':mcpForm', ':mcpEmptyAccept'));
  assert.equal(h.responses.length, 0); assert.ok(h.errors.length);
});

test('Discord refusal remains an explicit user action', async (context) => {
  const h = await harness(context); await h.emit(approval());
  const buttons = h.posted[0].components[0].toJSON().components;
  await h.click(buttons[1].custom_id);
  assert.deepEqual(h.responses, [{ id: 14, result: { action: 'decline' } }]);
});

test('Discord cancellation remains an explicit user action', async (context) => {
  const h = await harness(context); await h.emit(approval());
  const buttons = h.posted[0].components[0].toJSON().components;
  await h.click(buttons[2].custom_id);
  assert.deepEqual(h.responses, [{ id: 14, result: { action: 'cancel' } }]);
});

test('an empty generic form without tool-approval metadata still requires input', async (context) => {
  const h = await harness(context); await h.emit({ ...approval(), _meta: undefined });
  const button = h.posted[0].components[0].toJSON().components[0];
  assert.equal(button.label, '回答を入力');
  await h.click(button.custom_id.replace(':mcpForm', ':mcpEmptyAccept'));
  assert.equal(h.responses.length, 0);
});

test('a forged empty-accept cannot satisfy device identity verification', async (context) => {
  const h = await harness(context);
  await h.emit({ ...approval(), mode: 'openai/userVerification', challenge: 'challenge', title: 'Verify', description: 'Verify identity' });
  const record = [...h.controller.pendingRequests.values()][0];
  await h.click(`cx:req:${record.key}:mcpEmptyAccept`);
  assert.equal(h.responses.length, 0); assert.ok(h.errors.length);
});
