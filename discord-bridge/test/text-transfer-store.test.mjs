import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TextTransferStore } from '../src/text-transfer-store.mjs';

test('TextTransferStore atomically retains only the latest timestamped text', async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-transfer-text-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, '1000.txt'), 'stale one', 'utf8');
  fs.writeFileSync(path.join(directory, '1001.txt'), 'stale two', 'utf8');
  fs.writeFileSync(path.join(directory, 'keep.json'), '{}', 'utf8');

  const store = new TextTransferStore(directory);
  await store.ensureDirectory();
  assert.deepEqual(
    fs.readdirSync(directory).sort(),
    ['1001.txt', 'keep.json'],
  );

  const first = await store.store('first payload', 2000);
  assert.equal(first.filename, '2000.txt');
  assert.equal(fs.readFileSync(first.path, 'utf8'), 'first payload');
  assert.deepEqual(
    fs.readdirSync(directory).filter((name) => name.endsWith('.txt')),
    ['2000.txt'],
  );

  const second = await store.store('second payload\nwith another line', 2000);
  assert.equal(second.filename, '2001.txt');
  assert.equal(fs.readFileSync(second.path, 'utf8'), 'second payload\nwith another line');
  assert.deepEqual(
    fs.readdirSync(directory).filter((name) => name.endsWith('.txt')),
    ['2001.txt'],
  );
  assert.equal(fs.existsSync(path.join(directory, 'keep.json')), true);
});

test('TextTransferStore rejects empty content without replacing the current file', async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-transfer-text-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new TextTransferStore(directory);
  await store.store('current', 3000);

  await assert.rejects(store.store('', 3001), /non-empty string/);
  assert.deepEqual(fs.readdirSync(directory), ['3000.txt']);
});
