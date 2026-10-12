import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readJson, saveJson, deliveryFor, taskSnapshot } from './shared-task-operations.mjs';

test('delivery selects only the exact active turn or the same idle thread without settings overrides', () => {
  const [activeMethod, active] = deliveryFor('own', { id: 'exact' }, 'done');
  assert.equal(activeMethod, 'turn/steer');
  assert.deepEqual(Object.keys(active).sort(), ['expectedTurnId', 'input', 'threadId']);
  assert.equal(active.expectedTurnId, 'exact');
  const [idleMethod, idle] = deliveryFor('own', null, 'done');
  assert.equal(idleMethod, 'turn/start');
  assert.deepEqual(Object.keys(idle).sort(), ['input', 'threadId']);
  assert.equal(idle.threadId, 'own');
});

test('metadata snapshot combines paginated ordinary and loaded tasks without resuming or starting them', async () => {
  const calls = [];
  const client = { call: async (method, params) => {
    calls.push([method, params]);
    if (method === 'thread/list') return params.cursor
      ? { data: [{ id: 'listed-active', status: { type: 'active' } }] }
      : { data: [{ id: 'own', status: { type: 'idle' } }], nextCursor: 'next' };
    if (method === 'thread/loaded/list') return { data: ['own', { id: 'loaded-active' }, 'own'] };
    if (method === 'thread/read') return { thread: { id: params.threadId, cwd: 'C:/test', status: { type: params.threadId === 'own' ? 'idle' : 'active' } } };
    if (method === 'thread/turns/list') return { data: [{ id: 'exact', status: 'inProgress' }] };
    throw new Error('Unexpected mutation');
  } };
  const snapshot = await taskSnapshot(client, 'own');
  assert.deepEqual(snapshot.otherActive.sort(), ['listed-active', 'loaded-active']);
  assert.equal(snapshot.loadedCount, 2);
  assert.equal(snapshot.activeTurn.id, 'exact');
  assert.ok(calls.filter(([method]) => method === 'thread/read').every(([, params]) => params.includeTurns === false));
  assert.ok(calls.every(([method]) => !['thread/resume', 'turn/start', 'turn/steer'].includes(method)));
});

test('repeated pagination and mismatched owner identities fail closed', async () => {
  await assert.rejects(taskSnapshot({ call: async () => ({ data: [], nextCursor: 'same' }) }, 'own'), /repeated/);
  const client = { call: async method => method === 'thread/read' ? { thread: { id: 'different' } } : { data: [] } };
  await assert.rejects(taskSnapshot(client, 'own'), /identity mismatch/);
});

test('shared JSON helpers support BOM input and persist Unicode without a state-directory dependency', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-shared-task-json-'));
  try {
    const file = path.join(directory, 'state.json');
    fs.writeFileSync(file, '\uFEFF{"value":"日本語"}');
    assert.equal(readJson(file).value, '日本語');
    saveJson(file, { phase: 'dispatching', value: '日本語' });
    assert.deepEqual(readJson(file), { phase: 'dispatching', value: '日本語' });
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
