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
  discover7Zip,
  disposeSplitArchive,
  readArchiveVolume,
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
