import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DiscordController } from '../src/discord-controller.mjs';

test('codex_app automation_update is handled through the local automation store', async (context) => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-automation-routing-'));
  context.after(() => fs.rmSync(logDir, { recursive: true, force: true }));
  const client = new EventEmitter();
  const codex = new EventEmitter();
  const stateStore = { binding: () => null };
  let received = null;
  let response = null;
  const completed = new Promise((resolve) => {
    codex.respondToServerRequest = (requestId, result) => {
      response = { requestId, result };
      resolve();
    };
  });
  const automationStore = {
    execute: (args, contextValue) => {
      received = { args, contextValue };
      return {
        automation: {
          id: 'youtube',
          kind: 'heartbeat',
          rrule: 'FREQ=MINUTELY;INTERVAL=30',
        },
      };
    },
  };
  const controller = new DiscordController({
    client,
    codex,
    stateStore,
    config: {},
    logDir,
    automationStore,
    desktopClientInspector: () => ({
      state: 'absent',
      generation: 'test-server',
      reason: 'test-no-desktop',
    }),
  });
  controller.attach();

  codex.emit('serverRequest', {
    id: 42,
    method: 'item/tool/call',
    params: {
      threadId: 'thread-123',
      namespace: 'codex_app',
      tool: 'automation_update',
      arguments: { mode: 'view', id: 'youtube' },
    },
  });
  await completed;

  assert.deepEqual(received, {
    args: { mode: 'view', id: 'youtube' },
    contextValue: { threadId: 'thread-123' },
  });
  assert.equal(response.requestId, 42);
  assert.equal(response.result.success, true);
  assert.deepEqual(JSON.parse(response.result.contentItems[0].text), {
    automation: {
      id: 'youtube',
      kind: 'heartbeat',
      rrule: 'FREQ=MINUTELY;INTERVAL=30',
    },
  });
});

test('automation errors are returned to Codex without posting the generic Discord warning', async (context) => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-automation-routing-error-'));
  context.after(() => fs.rmSync(logDir, { recursive: true, force: true }));
  const client = new EventEmitter();
  const codex = new EventEmitter();
  const stateStore = { binding: () => ({ channelId: 'task-channel' }) };
  let channelFetches = 0;
  client.channels = {
    fetch: async () => {
      channelFetches += 1;
      return { send: async () => ({ id: 'message' }) };
    },
  };
  const completed = new Promise((resolve) => {
    codex.respondToServerRequest = (requestId, result) => resolve({ requestId, result });
  });
  const controller = new DiscordController({
    client,
    codex,
    stateStore,
    config: {},
    logDir,
    automationStore: {
      execute: () => {
        throw new Error('Automation not found: missing.');
      },
    },
    desktopClientInspector: () => ({
      state: 'absent',
      generation: 'test-server',
      reason: 'test-no-desktop',
    }),
  });
  controller.attach();

  codex.emit('serverRequest', {
    id: 43,
    method: 'item/tool/call',
    params: {
      threadId: 'thread-123',
      namespace: 'codex_app',
      tool: 'automation_update',
      arguments: { mode: 'view', id: 'missing' },
    },
  });
  const response = await completed;

  assert.equal(response.result.success, false);
  assert.match(response.result.contentItems[0].text, /Automation not found/);
  assert.equal(channelFetches, 0);
});

test('effectful codex_app tools are left to a verified Desktop owner', async (context) => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-client-tool-owner-'));
  context.after(() => fs.rmSync(logDir, { recursive: true, force: true }));
  const client = new EventEmitter();
  const codex = new EventEmitter();
  codex.status = () => ({ endpoint: 'ws://127.0.0.1:8798' });
  let executions = 0;
  let responses = 0;
  codex.respondToServerRequest = () => { responses += 1; };
  const ledger = new Map();
  const stateStore = {
    binding: () => null,
    clientToolRequest: (key) => ledger.get(key) ?? null,
    setClientToolRequest: (key, value) => ledger.set(key, { ...ledger.get(key), ...value }),
  };
  const controller = new DiscordController({
    client,
    codex,
    stateStore,
    config: { clientToolOwnerTimeoutMs: 100 },
    logDir,
    clientToolRouter: { execute: async () => { executions += 1; return {}; } },
    desktopClientInspector: () => ({
      state: 'present',
      generation: 'test-server',
      reason: 'verified-desktop-process-alive',
    }),
  });
  controller.attach();
  codex.emit('notification', {
    method: 'item/completed',
    params: { threadId: 'source', turnId: 'turn-source' },
  });
  codex.emit('serverRequest', {
    id: 50,
    method: 'item/tool/call',
    params: {
      threadId: 'source',
      turnId: 'turn-source',
      namespace: 'codex_app',
      tool: 'send_message_to_thread',
      arguments: {},
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(executions, 0);
  assert.equal(responses, 0);

  assert.equal([...ledger.values()][0].status, 'delegated');
  codex.emit('notification', {
    method: 'item/completed',
    params: { threadId: 'source', turnId: 'turn-source' },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(executions, 0);
  assert.equal(responses, 0);
  assert.equal([...ledger.values()][0].status, 'resolved-by-desktop-progress');
  await controller.stop();
});

test('effectful client tool fallback executes once and replays its persisted response', async (context) => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-client-tool-fallback-'));
  context.after(() => fs.rmSync(logDir, { recursive: true, force: true }));
  const client = new EventEmitter();
  const codex = new EventEmitter();
  codex.status = () => ({ endpoint: 'ws://127.0.0.1:8798' });
  const responses = [];
  codex.respondToServerRequest = (requestId, result) => responses.push({ requestId, result });
  let executions = 0;
  const ledger = new Map();
  const stateStore = {
    binding: () => null,
    clientToolRequest: (key) => ledger.get(key) ?? null,
    setClientToolRequest: (key, value) => ledger.set(key, { ...ledger.get(key), ...value }),
  };
  const controller = new DiscordController({
    client,
    codex,
    stateStore,
    config: {},
    logDir,
    clientToolRouter: { execute: async () => { executions += 1; return { turnId: 'turn-1' }; } },
    desktopClientInspector: () => ({
      state: 'absent',
      generation: 'test-server',
      reason: 'no-desktop-process-alive',
    }),
  });
  controller.attach();
  const request = {
    id: 51,
    method: 'item/tool/call',
    params: { threadId: 'source', namespace: 'codex_app', tool: 'send_message_to_thread', arguments: {} },
  };
  codex.emit('serverRequest', request);
  await new Promise((resolve) => setImmediate(resolve));
  codex.emit('serverRequest', request);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(executions, 1);
  assert.equal(responses.length, 2);
  assert.deepEqual(responses[0].result, responses[1].result);
});

test('ambiguous Desktop ownership fails closed after the configured wait', async (context) => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-client-tool-ambiguous-'));
  context.after(() => fs.rmSync(logDir, { recursive: true, force: true }));
  const client = new EventEmitter();
  const codex = new EventEmitter();
  codex.status = () => ({ endpoint: 'ws://127.0.0.1:8798' });
  let executions = 0;
  let complete;
  const responsePromise = new Promise((resolve) => { complete = resolve; });
  codex.respondToServerRequest = (requestId, result) => complete({ requestId, result });
  const ledger = new Map();
  const stateStore = {
    binding: () => null,
    snapshot: () => ({ infrastructure: {} }),
    clientToolRequest: (key) => ledger.get(key) ?? null,
    setClientToolRequest: (key, value) => ledger.set(key, { ...ledger.get(key), ...value }),
  };
  const controller = new DiscordController({
    client,
    codex,
    stateStore,
    config: { clientToolOwnerTimeoutMs: 10 },
    logDir,
    clientToolRouter: { execute: async () => { executions += 1; return {}; } },
    desktopClientInspector: () => ({
      state: 'ambiguous',
      generation: 'test-server',
      reason: 'desktop-connection-unverified',
    }),
  });
  controller.attach();
  codex.emit('serverRequest', {
    id: 52,
    method: 'item/tool/call',
    params: { threadId: 'source', namespace: 'codex_app', tool: 'create_thread', arguments: {} },
  });
  const response = await responsePromise;

  assert.equal(executions, 0);
  assert.equal(response.requestId, 52);
  assert.equal(response.result.success, false);
  assert.match(response.result.contentItems[0].text, /did not execute it/);
});

test('a persisted delegated request is never executed after reconnect', async (context) => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-client-tool-reconnect-'));
  context.after(() => fs.rmSync(logDir, { recursive: true, force: true }));
  const client = new EventEmitter();
  const codex = new EventEmitter();
  codex.status = () => ({ endpoint: 'ws://127.0.0.1:8798' });
  let executions = 0;
  let complete;
  const responsePromise = new Promise((resolve) => { complete = resolve; });
  codex.respondToServerRequest = (requestId, result) => complete({ requestId, result });
  const ledger = new Map([[
    'test-server|request:53',
    { status: 'delegated', tool: 'send_message_to_thread' },
  ]]);
  const stateStore = {
    binding: () => null,
    clientToolRequest: (key) => ledger.get(key) ?? null,
    setClientToolRequest: (key, value) => ledger.set(key, { ...ledger.get(key), ...value }),
  };
  const controller = new DiscordController({
    client,
    codex,
    stateStore,
    config: {},
    logDir,
    clientToolRouter: { execute: async () => { executions += 1; return {}; } },
    desktopClientInspector: () => ({
      state: 'absent',
      generation: 'test-server',
      reason: 'no-desktop-process-alive',
    }),
  });
  controller.attach();
  codex.emit('serverRequest', {
    id: 53,
    method: 'item/tool/call',
    params: { threadId: 'source', namespace: 'codex_app', tool: 'send_message_to_thread', arguments: {} },
  });
  const response = await responsePromise;

  assert.equal(executions, 0);
  assert.equal(response.result.success, false);
  assert.match(response.result.contentItems[0].text, /outcome is unknown/);
  assert.equal(ledger.get('test-server|request:53').status, 'failed-closed');
});
