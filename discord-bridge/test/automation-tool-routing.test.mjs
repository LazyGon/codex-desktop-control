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
