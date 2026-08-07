import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  blockedPathReason,
  extractLocalFileReferences,
  isDiscordInlineImageTarget,
  listProjectDirectory,
  resolveShareFile,
  uniqueDiscordAttachmentName,
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

test('Discord inline image detection accepts renderable local image links only', () => {
  assert.equal(isDiscordInlineImageTarget('C:\\work\\preview.PNG'), true);
  assert.equal(isDiscordInlineImageTarget('C:\\work\\photo.jpeg:12'), true);
  assert.equal(isDiscordInlineImageTarget('C:\\work\\animation.gif'), true);
  assert.equal(isDiscordInlineImageTarget('C:\\work\\preview.webp'), true);
  assert.equal(isDiscordInlineImageTarget('C:\\work\\diagram.svg'), false);
  assert.equal(isDiscordInlineImageTarget('C:\\work\\notes.txt'), false);
  assert.equal(isDiscordInlineImageTarget('https://example.com/preview.png'), false);
});

test('Discord attachment names remain safe and unique within one card', () => {
  const used = new Set(['preview.png']);
  assert.equal(uniqueDiscordAttachmentName('preview.png', used), '2-preview.png');
  used.add('2-preview.png');
  assert.equal(uniqueDiscordAttachmentName('preview.png', used), '3-preview.png');
  assert.equal(uniqueDiscordAttachmentName('unsafe:name.png'), 'unsafe_name.png');
});

test('project browser allows ordinary development folders and secret-named files', async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-file-browser-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'src'));
  fs.mkdirSync(path.join(root, '.git'));
  fs.writeFileSync(path.join(root, 'README.md'), 'safe', 'utf8');
  fs.writeFileSync(path.join(root, '.env'), 'TOKEN=secret', 'utf8');

  const listing = await listProjectDirectory(root);
  assert.deepEqual(listing.entries.map((entry) => entry.name), ['.git', 'src', '.env', 'README.md']);
  assert.equal(listing.entries.find((entry) => entry.name === '.git').navigable, true);
  assert.equal(listing.entries.find((entry) => entry.name === '.env').downloadable, true);
  assert.equal(listing.entries.find((entry) => entry.name === 'README.md').downloadable, true);
});

test('file resolution allows files outside project roots and secret-named files', async (context) => {
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
  assert.equal(
    (await resolveShareFile(path.join(root, 'token.dpapi'), [root])).path,
    fs.realpathSync(path.join(root, 'token.dpapi')),
  );
  assert.equal((await resolveShareFile(outsidePath, [root])).path, fs.realpathSync(outsidePath));
  assert.equal(blockedPathReason(path.join('.codex', 'auth.json')), null);
  assert.match(blockedPathReason('C:\\Windows\\System32\\config\\SAM'), /Windows/);
});

test('private-key content is allowed outside Windows protected folders', async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-file-content-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'notes.txt');
  fs.writeFileSync(filePath, '-----BEGIN OPENSSH PRIVATE KEY-----\nsecret', 'utf8');
  assert.equal((await resolveShareFile(filePath, [root])).path, fs.realpathSync(filePath));
});

test('task-scoped runtime roots and their protected-named children are downloadable', async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-runtime-root-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const root = path.join(directory, '.codex', 'visualizations', '2026', '07', '25', 'thread-1');
  fs.mkdirSync(root, { recursive: true });
  const artifact = path.join(root, 'artifact.zip');
  const secret = path.join(root, '.env');
  fs.writeFileSync(artifact, 'artifact', 'utf8');
  fs.writeFileSync(secret, 'TOKEN=secret', 'utf8');

  assert.equal(
    (await resolveShareFile(artifact, [root])).path,
    fs.realpathSync(artifact),
  );
  assert.equal((await resolveShareFile(secret, [root])).path, fs.realpathSync(secret));
});
