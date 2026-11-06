import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { BrowserInitialization, browserHostUnavailable } from '../src/browser-initialization.mjs';

const THREAD = '01a1abbd-0000-7000-8000-000000000001';
const TURN = '01a1af47-0000-7000-8000-000000000002';
const HOST_ERROR = 'The browser access host is unavailable';
const ITEM = {
  id: 'call_test', type: 'mcpToolCall', server: 'cua_repl', tool: 'js', status: 'failed',
  arguments: { code: 'let tab = await cua.getTab("42", { browser: "chrome" });' },
  result: { content: [{ type: 'text', text: HOST_ERROR }] },
};
const EVENT = { threadId: THREAD, turnId: TURN, item: ITEM };

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-browser-init-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'receipts');
  const state = {
    thread: { id: THREAD, source: 'vscode', ephemeral: false, canAcceptDirectInput: true,
      path: '/sessions/thread.jsonl', status: { type: 'active' } },
    turn: { id: TURN, status: 'completed', items: [ITEM] },
    generation: 'one', busy: false, subscribed: true, binding: { channelId: '42' }, opened: [], released: [],
    archive: [], goal: null, terminals: [], related: false, grace: 60_000, now: 1,
  };
  const codex = {
    browserInitializationGeneration: () => state.generation,
    readThreadMetadata: async () => state.thread,
    recentTurns: async () => ({ data: [state.turn] }),
    isSubscribed: () => state.subscribed,
    prepareDesktopThread: async (id) => { state.opened.push(id); return 'opening'; },
    releaseBrowserInitializationSubscription: async (id, generation) => {
      state.released.push([id, generation]);
      state.subscribed = false;
      return state.releaseAck;
    },
    browserUnloadGraceMs: async () => state.grace,
    withBrowserArchive: async (_id, run) => run(),
    getGoal: async () => ({ goal: state.goal }),
    listBackgroundTerminals: async () => state.terminals,
    browserArchiveHasRelations: async () => state.related,
    archiveThread: async (id) => {
      state.archive.push(['archive', id]);
      state.thread = { ...state.thread, path: '/archived_sessions/thread.jsonl', status: { type: 'notLoaded' } };
      return { threadId: id };
    },
    unarchiveThread: async (id) => {
      state.archive.push(['unarchive', id]);
      state.thread = { ...state.thread, path: '/sessions/thread.jsonl' };
      return { thread: state.thread };
    },
  };
  const make = (overrides = {}) => new BrowserInitialization({
    directory: dir, codex, binding: () => state.binding, isBusy: () => state.busy,
    clock: () => state.now, ...overrides,
  });
  const read = () => JSON.parse(fs.readFileSync(path.join(dir, `${THREAD}.json`), 'utf8'));
  return { state, make, read, codex };
}

test('only the exact built-in browser failure or its bare inventory result qualifies', () => {
  assert.equal(browserHostUnavailable(ITEM), true);
  assert.equal(browserHostUnavailable({ ...ITEM, server: 'other' }), false);
  assert.equal(browserHostUnavailable({ ...ITEM, type: 'agentMessage' }), false);
  assert.equal(browserHostUnavailable({ ...ITEM, status: 'completed' }), false);
  assert.equal(browserHostUnavailable({ ...ITEM, arguments: { code: 'await tab.playwright.domSnapshot()' } }), false);
  const inventory = {
    ...ITEM, status: 'completed', arguments: { code: 'await cua.getState();' },
    result: { content: [{ type: 'text', text: `Apps: ...\nBrowsers: Error: ${HOST_ERROR}` }] },
  };
  assert.equal(browserHostUnavailable(inventory), true);
  assert.equal(browserHostUnavailable({ ...inventory, arguments: { code: 'nodeRepl.write(pageText)' } }), false);
});

test('waits for the exact failed task, releases only the Bridge subscription, then opens it once', async (t) => {
  const { state, make, read } = fixture(t);
  let init = make();
  await init.run(); // No receipt directory exists before the first failure.
  assert.equal(init.observe(EVENT), true);
  await init.run();
  assert.deepEqual(state.released, []);
  state.thread.status.type = 'idle';
  state.busy = true;
  await init.run();
  assert.deepEqual(state.released, []);
  state.busy = false;
  await init.run();
  assert.deepEqual(state.released, [[THREAD, 'one']]);
  assert.equal(read().state, 'release-claimed');

  init = make();
  await init.run(); // Desktop still has its own loaded copy.
  assert.deepEqual(state.opened, []);
  state.thread.status.type = 'notLoaded';
  await init.run();
  assert.deepEqual(state.opened, [THREAD]);
  assert.equal(read().state, 'handed-off');
  assert.equal(make().observe(EVENT), false);
  await make().run();
  assert.deepEqual(state.opened, [THREAD]);
  assert.equal(state.released.length, 1);
});

test('ignores old and healthy work, even when the task is already unloaded', async (t) => {
  const { state, make, read } = fixture(t);
  state.thread.status.type = 'notLoaded';
  const init = make();
  assert.equal(init.observe(EVENT), true);
  state.turn.items.push({ ...ITEM, status: 'completed', result: { content: [] } });
  await init.run();
  assert.equal(read().state, 'superseded');
  assert.deepEqual(state.opened, []);
  const nextTurn = '01a1af47-0000-7000-8000-000000000003';
  assert.equal(init.observe({ ...EVENT, turnId: nextTurn }), true);
  state.turn.id = '01a1af47-0000-7000-8000-000000000004';
  await init.run();
  assert.equal(read().state, 'superseded');
  assert.deepEqual(state.opened, []);
});

test('rechecks binding, owner and task activity immediately before dispatch', async (t) => {
  const { state, make, codex } = fixture(t);
  state.thread.status.type = 'notLoaded';
  const init = make();
  assert.equal(init.observe(EVENT), true);
  state.binding.hidden = true;
  await init.run();
  assert.deepEqual(state.opened, []);
  state.binding.hidden = false;
  const read = codex.readThreadMetadata;
  let reads = 0;
  codex.readThreadMetadata = async () => {
    if (++reads === 2) state.generation = 'two';
    return read();
  };
  await init.run();
  assert.deepEqual(state.opened, []);
});

test('failure recovery does not consume its handoff before the shared coordinator claims an open', async (t) => {
  const { state, make, read, codex } = fixture(t);
  state.thread.status.type = 'notLoaded';
  const init = make();
  init.observe(EVENT);
  const prepare = codex.prepareDesktopThread;
  codex.prepareDesktopThread = async () => 'waiting';
  await init.run();
  assert.equal(read().state, 'pending');
  assert.deepEqual(state.opened, []);
  codex.prepareDesktopThread = prepare;
  await init.run();
  assert.equal(read().state, 'handed-off');
  assert.deepEqual(state.opened, [THREAD]);
});

test('uses one archive and restore when the normal grace is long, then delegates the exact cold load', async (t) => {
  const { state, make, read, codex } = fixture(t);
  state.thread.status.type = 'idle';
  state.releaseAck = 'unsubscribed';
  const archive = codex.archiveThread;
  codex.archiveThread = (id) => {
    assert.equal(read().state, 'archive-claimed');
    return archive(id);
  };
  const unarchive = codex.unarchiveThread;
  codex.unarchiveThread = (id) => {
    assert.equal(read().state, 'unarchive-claimed');
    assert.equal(state.thread.status.type, 'notLoaded');
    return unarchive(id);
  };
  const init = make();
  init.observe(EVENT);
  await init.run();
  await make().run();
  assert.deepEqual(state.released, [[THREAD, 'one']]);
  assert.deepEqual(state.archive, [['archive', THREAD], ['unarchive', THREAD]]);
  assert.deepEqual(state.opened, [THREAD]);
  assert.equal(read().state, 'handed-off');
});

test('lets the server unload naturally when the configured grace is only a few seconds', async (t) => {
  const { state, make, read } = fixture(t);
  state.thread.status.type = 'idle';
  state.releaseAck = 'unsubscribed';
  state.grace = 3_000;
  const init = make();
  init.observe(EVENT);
  await init.run();
  assert.equal(read().state, 'released');
  assert.deepEqual(state.archive, []);
  state.thread.status.type = 'notLoaded';
  await init.run();
  assert.deepEqual(state.archive, []);
  assert.deepEqual(state.opened, [THREAD]);
});

test('related tasks, goals, terminals, and a newly active turn prevent the archive', async (t) => {
  const { state, make, codex } = fixture(t);
  state.thread.status.type = 'idle';
  state.subscribed = false;
  const init = make();
  init.observe(EVENT);
  state.related = true;
  await init.run();
  state.related = false;
  state.goal = { status: 'paused' };
  await init.run();
  state.goal = null;
  state.terminals = [{ id: 'terminal' }];
  await init.run();
  state.terminals = [];
  codex.browserArchiveHasRelations = async () => { state.thread.status.type = 'active'; return false; };
  await init.run();
  assert.deepEqual(state.archive, []);
  assert.deepEqual(state.opened, []);
});

test('uncertain archive or restore leaves a durable fence without another mutation', async (t) => {
  for (const [method, stateName, actions] of [
    ['archiveThread', 'archive-claimed', [['archive', THREAD]]],
    ['unarchiveThread', 'unarchive-claimed', [['archive', THREAD], ['unarchive', THREAD]]],
  ]) {
    const { state, make, read, codex } = fixture(t);
    state.thread.status.type = 'idle';
    state.subscribed = false;
    const call = codex[method];
    codex[method] = async (id) => {
      if (method === 'archiveThread') await call(id);
      else state.archive.push(['unarchive', id]); // No restore is independently visible.
      throw new Error('lost acknowledgement');
    };
    const init = make();
    init.observe(EVENT);
    await init.run();
    assert.equal(read().state, stateName);
    await make().run();
    assert.deepEqual(state.archive, actions);
    assert.deepEqual(state.opened, []);
  }
});

test('reconciles a restored Windows path without resending archive or unarchive', async (t) => {
  const { state, make, read, codex } = fixture(t);
  state.thread.status.type = 'idle';
  state.subscribed = false;
  state.thread.path = '\\\\?\\C:\\Codex\\sessions\\thread.jsonl';
  const unarchive = codex.unarchiveThread;
  codex.unarchiveThread = async (id) => {
    await unarchive(id);
    state.thread.path = 'C:\\Codex\\sessions\\thread.jsonl';
    throw new Error('lost acknowledgement');
  };
  const init = make();
  init.observe(EVENT);
  await init.run();
  assert.equal(read().state, 'unarchive-claimed');
  assert.deepEqual(state.opened, []);
  await make().run();
  assert.deepEqual(state.archive, [['archive', THREAD], ['unarchive', THREAD]]);
  assert.deepEqual(state.opened, [THREAD]);
  assert.equal(read().state, 'handed-off');
});
