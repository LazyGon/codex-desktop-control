import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveShareFile } from '../src/local-file-share.mjs';
import {
  cleanupStaleSplitArchives,
  createSplit7zArchive,
  createSplit7zProjectArchive,
  discover7Zip,
  disposeSplitArchive,
  projectArchiveManifest,
  readArchiveVolume,
  scanProjectTree,
  splitArchiveManifest,
} from '../src/split-archive.mjs';

test('7z volumes stay under the Discord limit and extract to the exact original file', async (context) => {
  const executable = discover7Zip();
  if (!executable) {
    context.skip('7z.exe is not installed');
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-split-archive-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const tempRoot = path.join(root, 'transfers');
  const output = path.join(root, 'output');
  fs.mkdirSync(output);
  const original = randomBytes(50_000);
  const source = path.join(root, 'artifact.bin');
  fs.writeFileSync(source, original);
  const file = await resolveShareFile(source, [root]);
  const archive = await createSplit7zArchive(file, {
    volumeBytes: 10_000,
    maxBytes: 100_000,
    tempRoot,
    archiverPath: executable,
  });
  try {
    assert.equal(archive.format, 'split-7z-v1');
    assert.ok(archive.volumes.length > 1);
    assert.ok(archive.volumes.every((volume) => volume.size <= 10_000));
    assert.ok(archive.volumes.every((volume) => /^[a-f0-9]{64}$/.test(volume.sha256)));
    assert.ok(archive.volumes.every((volume, index) => volume.name.endsWith(`.${String(index + 1).padStart(3, '0')}`)));
    for (const volume of archive.volumes) {
      const content = await readArchiveVolume(volume);
      assert.equal(content.length, volume.size);
    }

    const manifest = splitArchiveManifest(archive);
    assert.equal(manifest.schema, 'codex-discord-file-transfer/v2');
    assert.equal(manifest.format, 'split-7z-v1');
    assert.equal(manifest.archive.volumes.length, archive.volumes.length);
    assert.equal(manifest.originalSha256, archive.original.sha256);

    const extraction = spawnSync(executable, [
      'x',
      '-y',
      `-o${output}`,
      archive.volumes[0].path,
    ], { encoding: 'utf8', windowsHide: true });
    assert.equal(extraction.status, 0, `${extraction.stdout}\n${extraction.stderr}`);
    assert.deepEqual(fs.readFileSync(path.join(output, path.basename(source))), original);
  } finally {
    await disposeSplitArchive(archive);
  }
  assert.deepEqual(fs.readdirSync(tempRoot), []);
});

test('project archive includes .git and protected files under the outer project directory', async (context) => {
  const executable = discover7Zip();
  if (!executable) {
    context.skip('7z.exe is not installed');
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-project-archive-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, 'sample-project');
  const tempRoot = path.join(root, 'transfers');
  const output = path.join(root, 'output');
  fs.mkdirSync(path.join(project, '.git'), { recursive: true });
  fs.mkdirSync(path.join(project, 'src'), { recursive: true });
  fs.mkdirSync(output);
  fs.writeFileSync(path.join(project, '.git', 'config'), '[core]\nrepositoryformatversion = 0\n', 'utf8');
  fs.writeFileSync(path.join(project, '.env'), 'TOKEN=secret\n', 'utf8');
  fs.writeFileSync(path.join(project, 'src', 'index.bin'), randomBytes(30_000));
  const outside = path.join(root, 'outside.txt');
  const link = path.join(project, 'outside-link.txt');
  fs.writeFileSync(outside, 'outside', 'utf8');
  let linkCreated = false;
  try {
    fs.symlinkSync(outside, link, 'file');
    linkCreated = true;
  } catch (error) {
    if (error.code !== 'EPERM') throw error;
  }

  const archive = await createSplit7zProjectArchive(project, {
    volumeBytes: 10_000,
    maxBytes: 100_000,
    tempRoot,
    archiverPath: executable,
  });
  try {
    assert.equal(archive.format, 'split-7z-project-v1');
    assert.ok(archive.volumes.length > 1);
    assert.ok(archive.volumes.every((volume) => volume.size <= 10_000));
    assert.equal(archive.project.files.some((file) => file.relativePath === path.join('.git', 'config')), true);
    assert.equal(archive.project.files.some((file) => file.relativePath === '.env'), true);
    if (linkCreated) assert.deepEqual(archive.project.skippedLinks, ['outside-link.txt']);

    const manifest = projectArchiveManifest(archive);
    assert.equal(manifest.schema, 'codex-discord-project-transfer/v1');
    assert.equal(manifest.includesGit, true);
    assert.equal(manifest.includesProtectedFiles, true);
    assert.equal(manifest.archive.entryRoot, 'sample-project');

    const extraction = spawnSync(executable, [
      'x',
      '-y',
      `-o${output}`,
      archive.volumes[0].path,
    ], { encoding: 'utf8', windowsHide: true });
    assert.equal(extraction.status, 0, `${extraction.stdout}\n${extraction.stderr}`);
    const extractedRoot = path.join(output, 'sample-project');
    assert.equal(fs.readFileSync(path.join(extractedRoot, '.git', 'config'), 'utf8'), '[core]\nrepositoryformatversion = 0\n');
    assert.equal(fs.readFileSync(path.join(extractedRoot, '.env'), 'utf8'), 'TOKEN=secret\n');
    assert.deepEqual(fs.readFileSync(path.join(extractedRoot, 'src', 'index.bin')), fs.readFileSync(path.join(project, 'src', 'index.bin')));
    if (linkCreated) assert.equal(fs.existsSync(path.join(extractedRoot, 'outside-link.txt')), false);
  } finally {
    await disposeSplitArchive(archive);
  }
});

test('project scan enforces the transfer ceiling before archiving', async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-project-limit-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'large.bin'), Buffer.alloc(20));
  await assert.rejects(scanProjectTree(root, 10), /転送上限/);
});

test('stale transfer cleanup only removes managed old transfer directories', async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-split-cleanup-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stale = path.join(root, 'transfer-stale');
  const fresh = path.join(root, 'transfer-fresh');
  const unrelated = path.join(root, 'keep-me');
  for (const directory of [stale, fresh, unrelated]) fs.mkdirSync(directory);
  const old = new Date(Date.now() - 48 * 60 * 60_000);
  fs.utimesSync(stale, old, old);
  const removed = await cleanupStaleSplitArchives(root, 24 * 60 * 60_000);
  assert.equal(removed, 1);
  assert.equal(fs.existsSync(stale), false);
  assert.equal(fs.existsSync(fresh), true);
  assert.equal(fs.existsSync(unrelated), true);
});
