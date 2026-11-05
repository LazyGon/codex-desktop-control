import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';

const INLINE_IMAGE_PREFIX = 'data:image/';

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function imageExtension(mime) {
  const known = new Map([
    ['image/jpeg', 'jpg'], ['image/png', 'png'], ['image/webp', 'webp'],
    ['image/gif', 'gif'], ['image/avif', 'avif'], ['image/bmp', 'bmp'],
    ['image/svg+xml', 'svg'], ['image/tiff', 'tif'], ['image/x-icon', 'ico'],
    ['image/vnd.microsoft.icon', 'ico'],
  ]);
  if (known.has(mime)) return known.get(mime);
  const subtype = mime.slice('image/'.length).toLowerCase().replace(/\+xml$/, '');
  return /^[a-z0-9][a-z0-9._-]{0,30}$/.test(subtype) ? subtype : 'bin';
}

function decodeImageDataUrl(url) {
  if (typeof url !== 'string' || !url.startsWith(INLINE_IMAGE_PREFIX)) return null;
  const match = /^data:(image\/[A-Za-z0-9.+-]+);base64,([A-Za-z0-9+/]*={0,2})$/.exec(url);
  if (!match || match[2].length === 0 || match[2].length % 4 !== 0) {
    throw new Error('Inline image data URL has invalid base64.');
  }
  const bytes = Buffer.from(match[2], 'base64');
  if (bytes.length === 0 || bytes.toString('base64') !== match[2]) {
    throw new Error('Inline image data URL has invalid base64.');
  }
  return { mime: match[1].toLowerCase(), bytes };
}

function findObjectSpans(text) {
  const stack = [];
  const spans = [];
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') stack.push(index);
    else if (char === '}' && stack.length) spans.push({ start: stack.pop(), end: index + 1 });
  }
  return spans;
}

function lineEndingStart(bytes) {
  return bytes.length && bytes[bytes.length - 1] === 13 ? bytes.length - 1 : bytes.length;
}

async function* lfByteRecords(stream) {
  let pending = Buffer.alloc(0);
  for await (const chunk of stream) {
    let cursor = 0;
    while (cursor < chunk.length) {
      const lf = chunk.indexOf(10, cursor);
      if (lf < 0) break;
      const part = chunk.subarray(cursor, lf + 1);
      yield pending.length ? Buffer.concat([pending, part]) : Buffer.from(part);
      pending = Buffer.alloc(0);
      cursor = lf + 1;
    }
    if (cursor < chunk.length) {
      const rest = chunk.subarray(cursor);
      pending = pending.length ? Buffer.concat([pending, rest]) : Buffer.from(rest);
    }
  }
  if (pending.length) yield pending;
}

function replaceInlineImages(recordBytes, context) {
  const targets = findInlineImageObjects(recordBytes);
  if (!targets.length) return { bytes: recordBytes, replacements: [] };
  const parseEnd = lineEndingStart(recordBytes);
  const bodyBytes = recordBytes.subarray(0, parseEnd);
  const text = bodyBytes.toString('utf8');

  const edits = [];
  const replacements = [];
  let consumedThrough = -1;
  for (const target of targets) {
    if (target.start < consumedThrough) continue;
    const asset = saveAsset(target.image, context);
    const reference = `[保存済み画像参照: ${asset.path.replaceAll('\\', '/')} | ${asset.mime} | SHA-256 ${asset.sha256}]`;
    const replacement = JSON.stringify({ type: 'input_text', text: reference });
    const startByte = Buffer.byteLength(text.slice(0, target.start), 'utf8');
    const objectByteLength = Buffer.byteLength(text.slice(target.start, target.end), 'utf8');
    const replacementBytes = Buffer.byteLength(replacement, 'utf8');
    const paddingLength = objectByteLength - replacementBytes;
    if (paddingLength < 0) throw new Error('Image reference replacement exceeds its source object.');
    edits.push({ start: startByte, end: startByte + objectByteLength,
      bytes: Buffer.from(`${replacement}${' '.repeat(paddingLength)}`, 'utf8') });
    replacements.push({ sourceOffset: context.recordOffset + startByte,
      outputOffset: context.recordOffset + startByte, byteLength: objectByteLength,
      sha256: asset.sha256, path: asset.path, mime: asset.mime });
    consumedThrough = target.end;
  }

  let cursor = 0;
  const pieces = [];
  for (const edit of edits) {
    pieces.push(bodyBytes.subarray(cursor, edit.start), edit.bytes);
    cursor = edit.end;
  }
  pieces.push(bodyBytes.subarray(cursor), recordBytes.subarray(parseEnd));
  const output = Buffer.concat(pieces);
  if (!output.equals(recordBytes) && output.length !== recordBytes.length) {
    throw new Error('Image reference replacement changed record byte length.');
  }
  const outputBody = output.subarray(0, parseEnd).toString('utf8');
  JSON.parse(outputBody);
  return { bytes: output, replacements };
}

function findInlineImageObjects(recordBytes) {
  const parseEnd = lineEndingStart(recordBytes);
  const bodyBytes = recordBytes.subarray(0, parseEnd);
  const text = bodyBytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bodyBytes)) throw new Error('Rollout contains invalid UTF-8.');
  JSON.parse(text);

  const targets = [];
  for (const span of findObjectSpans(text)) {
    const objectText = text.slice(span.start, span.end);
    let object;
    try { object = JSON.parse(objectText); } catch { continue; }
    if (object && !Array.isArray(object) && object.type === 'input_image'
      && typeof object.image_url === 'string' && object.image_url.startsWith(INLINE_IMAGE_PREFIX)) {
      targets.push({ ...span, image: decodeImageDataUrl(object.image_url) });
    }
  }
  return targets.sort((left, right) => left.start - right.start);
}

function saveAsset(image, context) {
  const digest = sha256(image.bytes);
  const existingRecord = context.assetsByHash.get(digest);
  if (existingRecord) {
    return { ...existingRecord, mime: image.mime };
  }
  const destination = path.join(context.assetDirectory, `${digest}.${imageExtension(image.mime)}`);
  fs.mkdirSync(context.assetDirectory, { recursive: true });
  if (fs.existsSync(destination)) {
    verifyAsset(destination, digest, image.bytes.length);
  } else {
    try {
      fs.writeFileSync(destination, image.bytes, { flag: 'wx' });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      verifyAsset(destination, digest, image.bytes.length);
    }
    syncFile(destination);
    verifyAsset(destination, digest, image.bytes.length);
  }
  const asset = { path: destination, sha256: digest, byteLength: image.bytes.length, mime: image.mime };
  context.assetsByHash.set(digest, asset);
  return asset;
}

function verifyAsset(assetPath, expectedHash, expectedLength) {
  const bytes = fs.readFileSync(assetPath);
  if (bytes.length !== expectedLength || sha256(bytes) !== expectedHash) {
    throw new Error(`Existing image asset failed content verification: ${assetPath}`);
  }
}

function syncFile(filePath) {
  const fd = fs.openSync(filePath, 'r+');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

async function hashFile(filePath) {
  const hash = crypto.createHash('sha256');
  let byteLength = 0;
  for await (const chunk of fs.createReadStream(filePath)) {
    hash.update(chunk);
    byteLength += chunk.length;
  }
  return { sha256: hash.digest('hex'), byteLength };
}

/** Inspect inline image payloads without writing files or exposing their data URLs. */
export async function inspectImageReferences(sourcePath) {
  if (!sourcePath) throw new TypeError('sourcePath is required.');
  const source = path.resolve(sourcePath);
  const initialStat = fs.statSync(source);
  const initialHash = await hashFile(source);
  const afterInitialHash = fs.statSync(source);
  if (initialHash.byteLength !== initialStat.size || afterInitialHash.size !== initialStat.size
    || afterInitialHash.mtimeMs !== initialStat.mtimeMs) {
    throw new Error('Source changed while its initial identity was being read.');
  }
  const embeddedImages = [];
  const scannedHash = crypto.createHash('sha256');
  let scannedBytes = 0;
  let recordIndex = 0;
  let recordOffset = 0;
  for await (const record of lfByteRecords(fs.createReadStream(source))) {
    scannedHash.update(record);
    scannedBytes += record.length;
    const bodyText = record.subarray(0, lineEndingStart(record)).toString('utf8');
    for (const target of findInlineImageObjects(record)) {
      const localOffset = Buffer.byteLength(bodyText.slice(0, target.start), 'utf8');
      embeddedImages.push({ recordIndex, sourceOffset: recordOffset + localOffset,
        byteLength: Buffer.byteLength(bodyText.slice(target.start, target.end), 'utf8'),
        mime: target.image.mime, sha256: sha256(target.image.bytes),
        imageByteLength: target.image.bytes.length });
    }
    recordOffset += record.length;
    recordIndex++;
  }
  const finalStat = fs.statSync(source);
  if (scannedBytes !== initialStat.size || scannedHash.digest('hex') !== initialHash.sha256
    || finalStat.size !== initialStat.size || finalStat.mtimeMs !== initialStat.mtimeMs) {
    throw new Error('Source changed while image references were inspected.');
  }
  return { sourcePath: source, sourceSha256: initialHash.sha256, byteLength: initialHash.byteLength,
    embeddedImages };
}

async function writeChunk(stream, bytes) {
  if (!stream.write(bytes)) await once(stream, 'drain');
}

/** Move inline image data from JSONL records into content-addressed files. */
export async function prepareImageReferences({ sourcePath, outputPath, assetDirectory }) {
  if (!sourcePath || !outputPath || !assetDirectory) {
    throw new TypeError('sourcePath, outputPath, and assetDirectory are required.');
  }
  const source = path.resolve(sourcePath);
  const output = path.resolve(outputPath);
  const assetsRoot = path.resolve(assetDirectory);
  if (source === output) throw new Error('Source and output paths must differ.');
  if (fs.existsSync(output)) throw new Error(`Output already exists: ${output}`);

  const initialStat = fs.statSync(source);
  const initialHash = await hashFile(source);
  const afterInitialHash = fs.statSync(source);
  if (initialHash.byteLength !== initialStat.size || afterInitialHash.size !== initialStat.size
    || afterInitialHash.mtimeMs !== initialStat.mtimeMs) {
    throw new Error('Source changed while its initial identity was being read.');
  }

  const partial = `${output}.partial`;
  const input = fs.createReadStream(source);
  const writer = fs.createWriteStream(partial, { flags: 'wx' });
  let rejectWriterFailure;
  const writerFailure = new Promise((_, reject) => { rejectWriterFailure = reject; });
  writerFailure.catch(() => {});
  writer.on('error', rejectWriterFailure);
  const context = { assetDirectory: assetsRoot, assetsByHash: new Map(), recordOffset: 0 };
  const records = [];
  const replacements = [];
  const scannedHash = crypto.createHash('sha256');
  const outputHash = crypto.createHash('sha256');
  let scannedBytes = 0;
  let recordIndex = 0;
  try {
    for await (const raw of lfByteRecords(input)) {
      scannedHash.update(raw);
      scannedBytes += raw.length;
      const changed = replaceInlineImages(raw, context);
      outputHash.update(changed.bytes);
      await Promise.race([writerFailure, writeChunk(writer, changed.bytes)]);
      if (changed.replacements.length) {
        const record = { recordIndex, sourceOffset: context.recordOffset,
          outputOffset: context.recordOffset, byteLength: raw.length,
          replacements: changed.replacements };
        records.push(record);
        replacements.push(...changed.replacements);
      }
      context.recordOffset += raw.length;
      recordIndex++;
    }
    writer.end();
    await Promise.race([writerFailure, once(writer, 'finish')]);
    const scannedSha256 = scannedHash.digest('hex');
    const finalStat = fs.statSync(source);
    if (scannedBytes !== initialStat.size || scannedBytes !== initialHash.byteLength
      || scannedSha256 !== initialHash.sha256 || finalStat.size !== initialStat.size
      || finalStat.mtimeMs !== initialStat.mtimeMs) {
      throw new Error('Source changed while image references were being prepared.');
    }
    syncFile(partial);
    if (fs.existsSync(output)) throw new Error(`Output already exists: ${output}`);
    fs.renameSync(partial, output);
    const outputSha256 = outputHash.digest('hex');
    return { sourcePath: source, outputPath: output, sourceSha256: initialHash.sha256,
      outputSha256, byteLength: scannedBytes,
      records, replacements, assets: [...context.assetsByHash.values()] };
  } catch (error) {
    input.destroy();
    writer.destroy();
    try { fs.unlinkSync(partial); } catch (cleanupError) {
      if (cleanupError.code !== 'ENOENT') error.cleanupError = cleanupError;
    }
    throw error;
  }
}
