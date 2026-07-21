import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  blockedPathReason,
  extractLocalFileReferences,
  inspectFileTransfer,
  listProjectDirectory,
  readTransferPart,
  resolveShareFile,
  transferManifest,
} from '../src/local-file-share.mjs';

test('local Markdown links accept Windows file targets and reject remote or relative targets', () => {
  const references = extractLocalFileReferences([
    '[forward](C:/git/project/file.txt:12)',
    '[leading slash](/C:/git/project/space file.txt)',
    '[backslash](C:\\git\\project\\other.txt)',
    '[file URI](file:///C:/git/project/image.png)',
    '[remote](https://example.com/file.txt)',
    '[relative](./file.txt)',
    '[network](\\\\server\\share\\file.txt)',
    '[alternate stream](C:\\git\\project\\file.txt:secret)',
  ].join('\n'));
  assert.deepEqual(references.map((reference) => reference.target), [
    'C:\\git\\project\\file.txt:12',
    'C:\\git\\project\\space file.txt',
    'C:\\git\\project\\other.txt',
    'C:\\git\\project\\image.png',
  ]);
});

test('project browser lists immediate entries and locks secret paths without hiding them', async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-file-browser-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'src'));
  fs.mkdirSync(path.join(root, '.git'));
  fs.writeFileSync(path.join(root, 'README.md'), 'safe', 'utf8');
  fs.writeFileSync(path.join(root, '.env'), 'TOKEN=secret', 'utf8');

  const listing = await listProjectDirectory(root);
  assert.deepEqual(listing.entries.map((entry) => entry.name), ['.git', 'src', '.env', 'README.md']);
  assert.equal(listing.entries.find((entry) => entry.name === '.git').navigable, false);
  assert.match(listing.entries.find((entry) => entry.name === '.git').lockedReason, /Git/);
  assert.equal(listing.entries.find((entry) => entry.name === '.env').downloadable, false);
  assert.match(listing.entries.find((entry) => entry.name === '.env').lockedReason, /secret/);
  assert.equal(listing.entries.find((entry) => entry.name === 'README.md').downloadable, true);
});

test('file resolution enforces project roots, strips line locations, and blocks secrets', async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-file-root-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-file-outside-'));
  context.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });
  const safePath = path.join(root, 'result.txt');
  fs.writeFileSync(safePath, 'result', 'utf8');
  fs.writeFileSync(path.join(root, 'token.dpapi'), 'encrypted', 'utf8');
  const outsidePath = path.join(outside, 'outside.txt');
  fs.writeFileSync(outsidePath, 'outside', 'utf8');

  const resolved = await resolveShareFile(`${safePath}:42:3`, [root]);
  assert.equal(resolved.path, fs.realpathSync(safePath));
  assert.equal(resolved.relativePath, 'result.txt');
  await assert.rejects(resolveShareFile(path.join(root, 'token.dpapi'), [root]), /秘密・保護対象/);
  await assert.rejects(resolveShareFile(outsidePath, [root]), /プロジェクトの外/);
  assert.match(blockedPathReason(path.join('.codex', 'auth.json')), /Codex/);
});

test('private-key content is blocked even with an ordinary filename', async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-file-content-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'notes.txt');
  fs.writeFileSync(filePath, '-----BEGIN OPENSSH PRIVATE KEY-----\nsecret', 'utf8');
  await assert.rejects(resolveShareFile(filePath, [root]), /秘密鍵本文/);
});

test('split transfer parts reassemble exactly and manifest hashes identify every chunk', async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-file-transfer-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const original = Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz', 'utf8');
  const filePath = path.join(root, 'artifact.bin');
  fs.writeFileSync(filePath, original);
  const file = await resolveShareFile(filePath, [root]);
  const transfer = await inspectFileTransfer(file, { chunkBytes: 7, maxBytes: 1000 });
  assert.equal(transfer.split, true);
  assert.equal(transfer.parts.length, Math.ceil(original.length / 7));
  const chunks = [];
  for (const part of transfer.parts) chunks.push(await readTransferPart(transfer, part));
  assert.deepEqual(Buffer.concat(chunks), original);
  const manifest = transferManifest(transfer);
  assert.equal(manifest.format, 'raw-concatenation-v1');
  assert.equal(manifest.parts.length, transfer.parts.length);
  assert.equal(manifest.sha256, transfer.sha256);
  assert.ok(manifest.parts.every((part) => /^[a-f0-9]{64}$/.test(part.sha256)));
});
