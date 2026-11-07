import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { CodexService } from '../src/codex-service.mjs';
import { DesktopFirst, desktopResumeSucceeded } from '../src/desktop-first.mjs';

const THREAD = '01a1abbd-0000-7000-8000-000000000001';
const OTHER = '01a1abbd-0000-7000-8000-000000000002';
const EPOCH = Date.parse('2026-11-06T04:42:36.000Z');
const line = (threadId = THREAD, ms = EPOCH + 200) => `${new Date(ms).toISOString()} info [AppServerConnection] response_routed broadcastFallback=false conversationId=${threadId} durationMs=100 errorCode=null hadInternalHandler=false hadPending=true method=thread/resume originWebcontentsId=null queueWaitMs=0 requestId=r targetDestroyed=null`;

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-first-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const logRoot = path.join(root, 'logs');
  const logDir = path.join(logRoot, '2026/11/06');
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = (pid) => path.join(logDir, `codex-desktop-0000-${pid}-t0-i1-041602-0.log`);
  const file = logFile(17);
  fs.writeFileSync(file, `${line(THREAD, EPOCH - 1_000)}\n`);
  const runtime = { generation: 'one', desktopPids: [17], logRoots: [logRoot], startedAt: EPOCH };
  const state = { runtime, status: 'notLoaded', opens: [], now: EPOCH };
  const metadata = (id) => ({ id, status: { type: state.status }, ephemeral: false, source: 'vscode', path: '/sessions/task.jsonl' });
  const options = {
    directory: path.join(root, 'records'), runtime: () => state.runtime,
    readThread: async (id) => metadata(id), clock: () => state.now,
    prepareNavigation: async () => async (id) => { state.opens.push(id); return true; },
  };
  return { make: (extra) => new DesktopFirst({ ...options, ...extra }), file, logFile, state, metadata,
    record: path.join(options.directory, `${THREAD}.json`) };
}

test('positive proof requires the exact task, successful local resume, and a fresh request', () => {
  assert.equal(desktopResumeSucceeded(line(), THREAD, EPOCH), true);
  assert.equal(desktopResumeSucceeded(line(OTHER), THREAD, EPOCH), false);
  assert.equal(desktopResumeSucceeded(line(THREAD, EPOCH + 99), THREAD, EPOCH), false);
  assert.equal(desktopResumeSucceeded(line().replace('errorCode=null', 'errorCode=-1'), THREAD, EPOCH), false);
  assert.equal(desktopResumeSucceeded(line().replace('hadPending=true', 'hadPending=false'), THREAD, EPOCH), false);
  assert.equal(desktopResumeSucceeded(`${line()} hostId=remote`, THREAD, EPOCH), false);
});

test('Bridge cannot load or send before the Desktop receipt and shared loaded state', async (t) => {
  const { make, file, logFile, state, metadata } = fixture(t);
  const calls = [];
  const service = new CodexService({ config: {}, stateStore: {}, logDir: os.tmpdir(), desktopFirst: make() });
  service.client = { connected: true, async call(method, params) {
    calls.push([method, params.threadId]);
    if (method === 'thread/resume') return { thread: metadata(params.threadId) };
    if (method === 'thread/turns/list') return { data: [] };
    if (method === 'turn/start') return { turn: { id: 'exact-turn' } };
    throw new Error(`Unexpected method: ${method}`);
  } };
  const deliver = () => service.deliver(THREAD, 'message', null, 'exact-request');
  await assert.rejects(deliver(), { code: 'DESKTOP_THREAD_PENDING' });
  await setImmediate();
  await assert.rejects(deliver(), { code: 'DESKTOP_THREAD_PENDING' });
  assert.deepEqual(state.opens, [THREAD]);
  assert.deepEqual(calls, []);

  state.status = 'idle';
  fs.writeFileSync(logFile(99), `${line()}\n`);
  fs.appendFileSync(file, `${line(OTHER)}\n${line()}`); // The exact receipt is still an incomplete line.
  await assert.rejects(deliver(), { code: 'DESKTOP_THREAD_PENDING' });
  assert.deepEqual(calls, []);
  fs.appendFileSync(file, '\n');
  state.status = 'notLoaded';
  await assert.rejects(deliver(), { code: 'DESKTOP_THREAD_PENDING' });
  assert.deepEqual(calls, []);

  state.status = 'idle';
  assert.equal((await deliver()).turnId, 'exact-turn');
  assert.deepEqual(calls, [['thread/resume', THREAD], ['thread/turns/list', THREAD], ['turn/start', THREAD]]);
  assert.equal(await service.prepareDesktopThread(THREAD), 'ready');
  assert.deepEqual(state.opens, [THREAD]);
});

test('uncertain Desktop navigation is not repeated after a Bridge restart', async (t) => {
  const { make, file, state } = fixture(t);
  const first = make({
    prepareNavigation: async () => async (id) => { state.opens.push(id); throw new Error('lost result'); },
  });
  assert.deepEqual(await Promise.all([first.prepare(THREAD), first.prepare(THREAD)]), ['waiting', 'waiting']);
  await setImmediate();
  assert.equal(await make().prepare(THREAD), 'opening');
  assert.deepEqual(state.opens, [THREAD]);
  fs.appendFileSync(file, `${line()}\n`);
  state.status = 'idle';
  await make().reconcile(); // Confirm the prior open even with no message waiting.
  state.status = 'notLoaded';
  state.now += 500;
  assert.equal(await make().prepare(THREAD), 'waiting');
  await setImmediate();
  assert.deepEqual(state.opens, [THREAD, THREAD]);
});

test('a cold task is not left with a claimed navigation after MCP startup fails', async (t) => {
  const { make, record, state } = fixture(t);
  const unavailable = make({ prepareNavigation: async () => { throw new Error('MCP handshake failed'); } });
  await unavailable.prepare(THREAD);
  await setImmediate();
  assert.equal(fs.existsSync(record), false);
  await make().prepare(THREAD);
  await setImmediate();
  assert.deepEqual(state.opens, [THREAD]);
});

test('an unresolved URI can hand off to the API once while preserving the old receipt', async (t) => {
  const { make, record, state } = fixture(t);
  fs.mkdirSync(path.dirname(record));
  const old = { threadId: THREAD, generation: 'one', phase: 'waiting', attemptId: 'old-uri',
    notBefore: EPOCH, desktopPids: [17], offsets: [] };
  fs.writeFileSync(record, JSON.stringify(old));
  await make().prepare(THREAD);
  await setImmediate();
  assert.equal(JSON.parse(fs.readFileSync(record, 'utf8')).previousUriAttempt.attemptId, old.attemptId);
  assert.equal(await make().prepare(THREAD), 'opening');
  assert.deepEqual(state.opens, [THREAD]);
});

test('an existing loaded task or an unavailable runtime does not get navigated', async (t) => {
  const { make, state } = fixture(t);
  state.status = 'idle';
  assert.equal(await make().prepare(THREAD), 'ready');
  state.status = 'notLoaded';
  state.runtime = null;
  assert.equal(await make().prepare(THREAD), 'disabled');
  assert.deepEqual(state.opens, []);
});
