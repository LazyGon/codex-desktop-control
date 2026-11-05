import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { inspectImageReferences, prepareImageReferences } from './image-reference-content.mjs';

function digest(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function fixtureDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'image-reference-content-'));
}

function paddedReference(asset, sourceByteLength) {
  const reference = JSON.stringify({
    type: 'input_text',
    text: `[保存済み画像参照: ${asset.path.replaceAll('\\', '/')} | ${asset.mime} | SHA-256 ${asset.sha256}]`,
  });
  const padding = sourceByteLength - Buffer.byteLength(reference);
  assert.ok(padding >= 0);
  return `${reference}${' '.repeat(padding)}`;
}

test('offloads nested inline images while preserving record bytes, unicode, offsets, and semantic text', async (t) => {
  const root = fixtureDirectory();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourcePath = path.join(root, 'source.jsonl');
  const outputPath = path.join(root, 'candidate.jsonl');
  const assetDirectory = path.join(root, 'assets');
  const imageBytes = Buffer.from(Array.from({ length: 256 }, (_, index) => index));
  const encoded = imageBytes.toString('base64');
  const inlineObject = `{ "image_url" : "data:image/png;base64,${encoded}", "type" : "input_image" }`;
  const fakeImageText = `escaped quote " \u0085\u2028\u2029 and fake {"type":"input_image","image_url":"data:image/png;base64,AA=="}`;
  const first = `{"message":${JSON.stringify(`雪 café 🐈 ${fakeImageText}`)},"nested":[{"kind":"actual","content":${inlineObject}}]}`;
  const second = `{"content":${inlineObject},"note":"終わり"}`;
  const sourceBytes = Buffer.from(`${first}\r\n${second}\n`, 'utf8');
  fs.writeFileSync(sourcePath, sourceBytes);

  const result = await prepareImageReferences({ sourcePath, outputPath, assetDirectory });
  const asset = { path: path.join(assetDirectory, `${digest(imageBytes)}.png`),
    sha256: digest(imageBytes), mime: 'image/png' };
  const firstStart = Buffer.byteLength(first.slice(0, first.indexOf(inlineObject)));
  const secondStart = Buffer.byteLength(first) + 2;
  const secondObjectStart = Buffer.byteLength(second.slice(0, second.indexOf(inlineObject)));
  const expected = Buffer.from(
    `${first.slice(0, first.indexOf(inlineObject))}${paddedReference(asset, Buffer.byteLength(inlineObject))}`
      + `${first.slice(first.indexOf(inlineObject) + inlineObject.length)}\r\n`
      + `${second.slice(0, second.indexOf(inlineObject))}${paddedReference(asset, Buffer.byteLength(inlineObject))}`
      + `${second.slice(second.indexOf(inlineObject) + inlineObject.length)}\n`,
    'utf8',
  );
  const outputBytes = fs.readFileSync(outputPath);

  assert.deepEqual(outputBytes, expected);
  assert.equal(outputBytes.length, sourceBytes.length);
  assert.equal(result.byteLength, sourceBytes.length);
  assert.equal(result.sourceSha256, digest(sourceBytes));
  assert.equal(result.outputSha256, digest(expected));
  assert.deepEqual(fs.readFileSync(sourcePath), sourceBytes);
  assert.deepEqual(result.assets, [{ ...asset, byteLength: imageBytes.length }]);
  assert.equal(fs.readFileSync(asset.path).toString('hex'), imageBytes.toString('hex'));
  assert.equal(result.records.length, 2);
  assert.equal(result.records[0].sourceOffset, 0);
  assert.equal(result.records[0].outputOffset, 0);
  assert.equal(result.records[0].byteLength, Buffer.byteLength(first) + 2);
  assert.equal(result.records[1].sourceOffset, secondStart);
  assert.equal(result.records[1].outputOffset, secondStart);
  assert.deepEqual(result.replacements.map(({ sourceOffset, outputOffset, byteLength }) =>
    ({ sourceOffset, outputOffset, byteLength })), [
    { sourceOffset: firstStart, outputOffset: firstStart, byteLength: Buffer.byteLength(inlineObject) },
    { sourceOffset: secondStart + secondObjectStart, outputOffset: secondStart + secondObjectStart,
      byteLength: Buffer.byteLength(inlineObject) },
  ]);
  const inspection = await inspectImageReferences(sourcePath);
  assert.equal(inspection.sourceSha256, digest(sourceBytes));
  assert.equal(inspection.embeddedImages.length, 2);
  assert.deepEqual(inspection.embeddedImages.map(({ recordIndex, sourceOffset, byteLength, mime, sha256: hash }) =>
    ({ recordIndex, sourceOffset, byteLength, mime, sha256: hash })), [
    { recordIndex: 0, sourceOffset: firstStart, byteLength: Buffer.byteLength(inlineObject),
      mime: 'image/png', sha256: digest(imageBytes) },
    { recordIndex: 1, sourceOffset: secondStart + secondObjectStart,
      byteLength: Buffer.byteLength(inlineObject), mime: 'image/png', sha256: digest(imageBytes) },
  ]);
  assert.equal(JSON.parse(outputBytes.toString('utf8').split('\r\n')[0]).nested[0].content.type, 'input_text');
  assert.equal(JSON.parse(outputBytes.toString('utf8').split('\n')[1]).note, '終わり');
});

test('repeated image bytes share one verified durable asset', async (t) => {
  const root = fixtureDirectory();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourcePath = path.join(root, 'source.jsonl');
  const imageBytes = Buffer.from(Array.from({ length: 256 }, (_, index) => 255 - index));
  const encoded = imageBytes.toString('base64');
  fs.writeFileSync(sourcePath, Buffer.from(
    `[{"type":"input_image","image_url":"data:image/jpeg;base64,${encoded}"},`
      + `{"image_url":"data:image/jpeg;base64,${encoded}","type":"input_image"}]\n`,
  ));
  const result = await prepareImageReferences({ sourcePath, outputPath: path.join(root, 'out.jsonl'),
    assetDirectory: path.join(root, 'assets') });
  assert.equal(result.assets.length, 1);
  assert.equal(result.replacements.length, 2);
  assert.equal(result.replacements[0].sha256, result.replacements[1].sha256);
  assert.equal(result.assets[0].path.endsWith('.jpg'), true);
  assert.equal(digest(fs.readFileSync(result.assets[0].path)), result.assets[0].sha256);
});

test('rejects a reference longer than its inline object without publishing a candidate', async (t) => {
  const root = fixtureDirectory();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourcePath = path.join(root, 'source.jsonl');
  const outputPath = path.join(root, 'candidate.jsonl');
  fs.writeFileSync(sourcePath, '{"type":"input_image","image_url":"data:image/png;base64,AQ=="}\n');
  const sourceBefore = fs.readFileSync(sourcePath);
  await assert.rejects(prepareImageReferences({ sourcePath, outputPath,
    assetDirectory: path.join(root, 'assets') }), /exceeds its source object/);
  assert.equal(fs.existsSync(outputPath), false);
  assert.equal(fs.existsSync(`${outputPath}.partial`), false);
  assert.deepEqual(fs.readFileSync(sourcePath), sourceBefore);
});

test('refuses an existing asset whose bytes do not match its content address', async (t) => {
  const root = fixtureDirectory();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourcePath = path.join(root, 'source.jsonl');
  const outputPath = path.join(root, 'candidate.jsonl');
  const assetDirectory = path.join(root, 'assets');
  const imageBytes = Buffer.from([7, 8, 9, 10]);
  const assetPath = path.join(assetDirectory, `${digest(imageBytes)}.png`);
  fs.mkdirSync(assetDirectory, { recursive: true });
  fs.writeFileSync(assetPath, Buffer.from('corrupt'));
  fs.writeFileSync(sourcePath,
    `{"type":"input_image","image_url":"data:image/png;base64,${imageBytes.toString('base64')}"}\n`);
  await assert.rejects(prepareImageReferences({ sourcePath, outputPath, assetDirectory }),
    /failed content verification/);
  assert.equal(fs.existsSync(outputPath), false);
  assert.equal(fs.readFileSync(assetPath, 'utf8'), 'corrupt');
});

test('rejects invalid inline base64 and preserves the source', async (t) => {
  const root = fixtureDirectory();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourcePath = path.join(root, 'source.jsonl');
  const source = '{"type":"input_image","image_url":"data:image/png;base64,AB=="}\n';
  fs.writeFileSync(sourcePath, source);
  await assert.rejects(prepareImageReferences({ sourcePath, outputPath: path.join(root, 'candidate.jsonl'),
    assetDirectory: path.join(root, 'assets') }), /invalid base64/);
  assert.equal(fs.readFileSync(sourcePath, 'utf8'), source);
});
