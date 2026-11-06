import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TaskMirrorDeletions } from '../src/task-mirror-deletions.mjs';

const thread = '01a1aeb4-2c9d-7620-96db-435a2fc5a68b';
const channelId = '111111111111111111';
const categoryId = '222222222222222222';
const guild = '333333333333333333';
const mirror = { id: channelId, parent_id: categoryId, guild_id: guild, type: 0, topic: `Codex task: ${thread}` };

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-mirror-delete-'));
  t.after(() => {
    fs.rmSync(path.join(dir, `${thread}.json`), { force: true });
    fs.rmdirSync(dir);
  });
  return () => new TaskMirrorDeletions(dir, guild);
}

test('a received deletion survives restart and cannot remove a different or still-owned task channel', async t => {
  const open = setup(t);
  open().observe(thread, { channelId, categoryId });
  const queue = open();
  const deleted = [];
  let finished = false;
  const operations = {
    readChannel: async () => ({ ...mirror, topic: `Codex task: ${thread}00` }),
    canDelete: async () => true,
    deleteChannel: async id => { deleted.push(id); },
    finish: async () => { finished = true; },
  };
  await queue.reconcile(thread, operations);
  await queue.reconcile(thread, { ...operations, readChannel: async () => mirror, canDelete: async () => false });
  assert.deepEqual(deleted, []);
  assert.equal(finished, false);

  await queue.reconcile(thread, { ...operations, readChannel: async () => mirror });
  assert.deepEqual(deleted, [channelId]);
  assert.equal(finished, true);
});

test('an uncertain DELETE is never repeated and only authoritative absence settles it', async t => {
  const open = setup(t);
  const original = open();
  original.observe(thread, { channelId, categoryId });
  const writes = [];
  const finished = [];
  const operations = {
    readChannel: async () => mirror,
    canDelete: async () => true,
    deleteChannel: async id => { writes.push(id); throw new Error('lost response'); },
    finish: async entry => { finished.push(entry.channelId); },
  };
  await assert.rejects(original.reconcile(thread, operations), /lost response/);
  const restarted = open();
  await restarted.reconcile(thread, operations);
  await assert.rejects(restarted.reconcile(thread, { ...operations, readChannel: async () => {
    throw Object.assign(new Error('not permitted'), { status: 403, code: 50013 });
  } }), /not permitted/);
  await restarted.reconcile(thread, { ...operations, readChannel: async () => null });
  assert.deepEqual(writes, [channelId]);
  assert.deepEqual(finished, []);

  await restarted.reconcile(thread, { ...operations, readChannel: async () => {
    throw Object.assign(new Error('unknown channel'), { status: 404, code: 10003 });
  } });
  assert.deepEqual(writes, [channelId]);
  assert.deepEqual(finished, [channelId]);
});
