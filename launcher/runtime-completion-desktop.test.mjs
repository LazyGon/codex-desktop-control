import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRuntimeCompletionRoute } from './runtime-completion-desktop.mjs';
import { deliverRuntimeCompletion } from './runtime-update-drain.mjs';

const threadId = '01a1b987-0000-7000-8000-000000000001';
const otherThreadId = '01a1b987-0000-7000-8000-000000000002';
const contextId = '01a1b987-0000-7000-8000-000000000003';
const replacementContextId = '01a1b987-0000-7000-8000-000000000004';
const endpoint = 'ws://127.0.0.1:8798';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-completion-desktop-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const statePath = path.join(root, 'current.json');
  const state = {
    mode: 'desktop', websocketUrl: endpoint, serverProcessId: process.pid, desktopProcessIds: [process.pid],
    desktopConnectionVerified: true, desktopBrowserAccessCompatibility: true, packageFamilyName: 'Fixture',
    startedAt: new Date(Date.now() - 10000).toISOString(),
  };
  const writeState = () => fs.writeFileSync(statePath, JSON.stringify(state));
  writeState();
  const logs = path.join(root, 'Codex', 'Logs', new Date().toISOString().slice(0, 10).replaceAll('-', '/'));
  fs.mkdirSync(logs, { recursive: true });
  const log = path.join(logs, `codex-desktop-abcd-${process.pid}-t0-000000-0.log`);
  fs.writeFileSync(log, '');
  function resume(id, errorCode = 'null') {
    fs.appendFileSync(log, `${new Date().toISOString()} info [AppServerConnection] response_routed `
      + `conversationId=${id} method=thread/resume errorCode=${errorCode} hadPending=true hostId=local durationMs=0\n`);
  }
  const live = { status: 'notLoaded', activeTurn: null, catalogMisses: 0, releaseUnconfirmed: false,
    loadedRace: false, contexts: [], releases: [], calls: [], deliveries: [], nav: [] };
  const { promise: afterTwoReads, resolve: readTwice } = Promise.withResolvers();
  const { promise: loadedWithoutProof, resolve: readLoadedWithoutProof } = Promise.withResolvers();
  let afterNav = 0;
  const client = { async call(method, params) {
    live.calls.push(method);
    if (method === 'thread/read') {
      assert.equal(params.threadId, threadId);
      if (live.loadedRace && live.calls.length === 2) live.status = 'idle';
      if (live.loadedRace && live.calls.length === 3) readLoadedWithoutProof();
      if (live.nav.length && ++afterNav === 2) readTwice();
      return { thread: { id: threadId, source: 'vscode', path: '/sessions/task.jsonl', ephemeral: false,
        status: { type: live.status } } };
    }
    if (method === 'thread/start') {
      assert.deepEqual(params, { ephemeral: true });
      const id = live.contexts.length ? replacementContextId : contextId;
      live.contexts.push(id);
      return { thread: { id, ephemeral: true, path: null } };
    }
    if (method === 'mcpServerStatus/list') return { data: live.catalogMisses-- > 0
      ? [] : [{ name: 'codex_app', tools: { navigate_to_codex_page: {} } }] };
    if (method === 'thread/unsubscribe') {
      assert.equal(params.threadId, contextId);
      live.releases.push(params.threadId);
      return { status: live.releaseUnconfirmed ? 'unconfirmed' : 'unsubscribed' };
    }
    if (method === 'mcpServer/tool/call') {
      live.nav.push(params);
      live.status = 'idle';
      resume(otherThreadId);
      resume(threadId, '-32600');
      throw new Error('Desktop navigation acknowledgement was lost');
    }
    if (method === 'thread/turns/list') return { data: live.activeTurn
      ? [{ id: live.activeTurn, status: 'inProgress' }] : [] };
    if (method === 'turn/steer' || method === 'turn/start') {
      live.deliveries.push({ method, params });
      return method === 'turn/steer' ? { turnId: params.expectedTurnId } : { turn: { id: 'accepted-start' } };
    }
    throw new Error(`Unexpected call: ${method}`);
  } };
  const route = () => createRuntimeCompletionRoute(client, {
    endpoint, expectedServerPid: process.pid, statePath, localAppData: root,
    requestId: 'b420a9c1-b3db-43b3-9026-c44763c967a1',
  });
  const deliver = () => deliverRuntimeCompletion(client, threadId, 'update settled', route());
  return { live, state, writeState, resume, afterTwoReads, loadedWithoutProof, deliver };
}

test('an unloaded completion waits for the exact Desktop resume and never retries uncertain navigation', { timeout: 10000 }, async t => {
  const f = fixture(t);
  const result = f.deliver();
  await Promise.race([f.afterTwoReads, result.then(() => assert.fail('Notification arrived before Desktop proof.'))]);
  assert.deepEqual(f.live.deliveries, []);
  f.live.status = 'active';
  f.live.activeTurn = 'newest-active-turn';
  f.resume(threadId);
  assert.equal((await result).turnId, 'newest-active-turn');
  assert.deepEqual(f.live.nav, [{ threadId: contextId, server: 'codex_app', tool: 'navigate_to_codex_page',
    arguments: { threadId } }]);
  assert.deepEqual(f.live.deliveries, [{ method: 'turn/steer',
    params: { threadId, expectedTurnId: 'newest-active-turn',
      input: [{ type: 'text', text: 'update settled', text_elements: [] }] } }]);
});

test('a catalog still starting releases its context and later navigates and delivers once', { timeout: 15000 }, async t => {
  const f = fixture(t);
  f.live.catalogMisses = 1;
  const result = f.deliver();
  await Promise.race([f.afterTwoReads, result.then(() => assert.fail('Notification arrived before Desktop proof.'))]);
  assert.deepEqual(f.live.releases, [contextId]);
  assert.deepEqual(f.live.contexts, [contextId, replacementContextId]);
  assert.deepEqual(f.live.deliveries, []);
  f.resume(threadId);
  assert.equal((await result).turnId, 'accepted-start');
  assert.equal(f.live.nav.length, 1);
  assert.equal(f.live.nav[0].threadId, replacementContextId);
  assert.equal(f.live.deliveries.length, 1);
});

test('an uncertain catalog context release never starts another context or a headless notification', async t => {
  const f = fixture(t);
  f.live.catalogMisses = 1;
  f.live.releaseUnconfirmed = true;
  await assert.rejects(f.deliver(), /No completion was sent/);
  assert.deepEqual(f.live.contexts, [contextId]);
  assert.deepEqual(f.live.nav, []);
  assert.deepEqual(f.live.deliveries, []);
  assert.equal(f.live.calls.includes('thread/resume'), false);
});

test('a task loaded concurrently must provide fresh Desktop evidence before delivery', { timeout: 10000 }, async t => {
  const f = fixture(t);
  f.live.loadedRace = true;
  const result = f.deliver();
  await Promise.race([f.loadedWithoutProof, result.then(() => assert.fail('Notification arrived without Desktop proof.'))]);
  assert.deepEqual(f.live.deliveries, []);
  f.resume(threadId);
  assert.equal((await result).turnId, 'accepted-start');
  assert.deepEqual(f.live.nav, []);
  assert.equal(f.live.deliveries.length, 1);
});

test('a changed shared runtime prevents a pending notification', { timeout: 10000 }, async t => {
  const f = fixture(t);
  const result = f.deliver();
  await Promise.race([f.afterTwoReads, result.then(() => assert.fail('Notification arrived before Desktop proof.'))]);
  f.state.startedAt = new Date().toISOString();
  f.writeState();
  f.resume(threadId);
  await assert.rejects(result, /shared Desktop changed/);
  assert.deepEqual(f.live.deliveries, []);
});

test('completion of an already loaded task leaves the Desktop view alone', async t => {
  const f = fixture(t);
  f.live.status = 'idle';
  assert.equal((await f.deliver()).turnId, 'accepted-start');
  assert.deepEqual(f.live.nav, []);
  assert.equal(f.live.calls.includes('thread/resume'), false);
});
