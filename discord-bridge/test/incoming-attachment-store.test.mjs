import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IncomingAttachmentStore } from '../src/incoming-attachment-store.mjs';

test('incoming attachments preserve arbitrary file bytes in a task-scoped inbox', async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-incoming-files-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const bodies = new Map([
    ['https://discord.test/report', Buffer.from('%PDF-test')],
    ['https://discord.test/archive', Buffer.from([0x50, 0x4b, 0x03, 0x04])],
  ]);
  const store = new IncomingAttachmentStore(directory, {
    maxFileBytes: 100,
    maxTotalBytes: 100,
    maxCount: 10,
    fetchImpl: async (url) => new Response(bodies.get(url), { status: 200 }),
  });

  const records = await store.store({
    threadId: '019f-test-thread',
    sourceId: '123456789012345678',
    attachments: [
      {
        id: '111111111111111111',
        name: 'review.pdf',
        size: bodies.get('https://discord.test/report').length,
        contentType: 'application/pdf',
        url: 'https://discord.test/report',
      },
      {
        id: '222222222222222222',
        name: 'source?.zip',
        size: bodies.get('https://discord.test/archive').length,
        contentType: 'application/zip',
        url: 'https://discord.test/archive',
      },
    ],
  });

  assert.deepEqual(records.map((record) => record.name), ['review.pdf', 'source_.zip']);
  assert.deepEqual(records.map((record) => record.contentType), ['application/pdf', 'application/zip']);
  assert.deepEqual(fs.readFileSync(records[0].path), bodies.get('https://discord.test/report'));
  assert.deepEqual(fs.readFileSync(records[1].path), bodies.get('https://discord.test/archive'));
  assert.ok(records.every((record) => path.resolve(record.path).startsWith(path.resolve(directory))));
  assert.match(records[0].path, /019f-test-thread[\\/]123456789012345678[\\/]111111111111111111[\\/]review\.pdf$/);
});

test('incoming attachment limits are enforced before downloading', async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-incoming-limits-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let fetches = 0;
  const store = new IncomingAttachmentStore(directory, {
    maxFileBytes: 5,
    maxTotalBytes: 8,
    maxCount: 2,
    fetchImpl: async () => {
      fetches += 1;
      return new Response('data', { status: 200 });
    },
  });
  const attachment = (id, name, size) => ({
    id,
    name,
    size,
    contentType: 'application/octet-stream',
    url: `https://discord.test/${id}`,
  });

  await assert.rejects(
    store.store({
      threadId: 'thread-1',
      sourceId: 'message-1',
      attachments: [attachment('a1', 'large.bin', 6)],
    }),
    /上限 5 bytes/,
  );
  await assert.rejects(
    store.store({
      threadId: 'thread-1',
      sourceId: 'message-2',
      attachments: [
        attachment('a1', 'one.bin', 4),
        attachment('a2', 'two.bin', 5),
      ],
    }),
    /合計は 8 bytes/,
  );
  await assert.rejects(
    store.store({
      threadId: 'thread-1',
      sourceId: 'message-3',
      attachments: [
        attachment('a1', 'one.bin', 1),
        attachment('a2', 'two.bin', 1),
        attachment('a3', 'three.bin', 1),
      ],
    }),
    /2件以下/,
  );
  assert.equal(fetches, 0);

  const streamedStore = new IncomingAttachmentStore(directory, {
    maxFileBytes: 5,
    maxTotalBytes: 8,
    maxCount: 2,
    fetchImpl: async () => new Response('123456', { status: 200 }),
  });
  await assert.rejects(
    streamedStore.store({
      threadId: 'thread-1',
      sourceId: 'message-4',
      attachments: [attachment('a4', 'misreported.bin', 4)],
    }),
    /受信上限/,
  );
  const partialDirectory = path.join(directory, 'thread-1', 'message-4', 'a4');
  const leftovers = fs.existsSync(partialDirectory) ? fs.readdirSync(partialDirectory) : [];
  assert.deepEqual(leftovers, []);
});
