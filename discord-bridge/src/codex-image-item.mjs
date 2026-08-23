import { createHash } from 'node:crypto';
import path from 'node:path';

const IMAGE_MIME_EXTENSIONS = new Map([
  ['image/avif', '.avif'],
  ['image/bmp', '.bmp'],
  ['image/gif', '.gif'],
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/webp', '.webp'],
]);

function normalizedMimeType(value) {
  return String(value ?? '').split(';', 1)[0].trim().toLocaleLowerCase('en-US');
}

function dataUrlParts(value) {
  const match = String(value ?? '').match(/^data:([^;,]+);base64,([\s\S]+)$/i);
  if (!match) return null;
  return { mimeType: normalizedMimeType(match[1]), data: match[2] };
}

function imagePayload(block) {
  if (!block || typeof block !== 'object') return null;
  const declaredMimeType = normalizedMimeType(block.mimeType ?? block.mime_type);
  const imageUrl = typeof block.image_url === 'string'
    ? block.image_url
    : typeof block.imageUrl === 'string'
      ? block.imageUrl
      : typeof block.image_url?.url === 'string'
        ? block.image_url.url
        : null;
  const fromUrl = dataUrlParts(imageUrl);
  const fromData = dataUrlParts(block.data);
  const mimeType = fromUrl?.mimeType ?? fromData?.mimeType ?? declaredMimeType;
  const data = fromUrl?.data ?? fromData?.data ?? (typeof block.data === 'string' ? block.data : null);
  if (!data || !IMAGE_MIME_EXTENSIONS.has(mimeType)) return null;
  if (block.type && !['image', 'input_image'].includes(block.type) && !declaredMimeType.startsWith('image/')) {
    return null;
  }
  return { mimeType, data };
}

function imagePayloadsFromItem(item) {
  const payloads = [];
  const seen = new Set();
  const visit = (value, depth = 0) => {
    if (!value || depth > 8) return;
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry, depth + 1);
      return;
    }
    if (typeof value !== 'object') return;
    if (seen.has(value)) return;
    seen.add(value);
    const payload = imagePayload(value);
    if (payload) {
      payloads.push(payload);
      return;
    }
    for (const nested of Object.values(value)) visit(nested, depth + 1);
  };

  // Tool arguments can contain arbitrary user text or sample data. Only inspect
  // fields that represent Codex/app-server output.
  visit(item?.content);
  visit(item?.result);
  visit(item?.output);
  return payloads;
}

function decodeBase64Image(data, maximumBytes) {
  const compact = String(data).replace(/\s+/g, '');
  if (!compact || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact) || compact.length % 4 === 1) {
    throw new Error('画像データが有効なbase64ではありません。');
  }
  const approximateBytes = Math.floor((compact.replace(/=+$/, '').length * 3) / 4);
  if (approximateBytes > maximumBytes) {
    throw new Error(`画像がDiscord添付上限を超えています (${approximateBytes} > ${maximumBytes})`);
  }
  const buffer = Buffer.from(compact, 'base64');
  const canonicalInput = compact.replace(/=+$/, '');
  const canonicalDecoded = buffer.toString('base64').replace(/=+$/, '');
  if (!buffer.length || canonicalDecoded !== canonicalInput) {
    throw new Error('画像データが有効なbase64ではありません。');
  }
  if (buffer.length > maximumBytes) {
    throw new Error(`画像がDiscord添付上限を超えています (${buffer.length} > ${maximumBytes})`);
  }
  return buffer;
}

function safeItemName(itemId) {
  return String(itemId ?? 'item')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120) || 'item';
}

export function hasCodexImageContent(item) {
  return imagePayloadsFromItem(item).length > 0
    || (item?.type === 'imageView' && typeof item.path === 'string' && item.path.length > 0);
}

export function codexImagePathAttachmentName(itemId, targetPath) {
  const extension = path.win32.extname(String(targetPath ?? '')).toLocaleLowerCase('en-US');
  return `codex-image-${safeItemName(itemId)}-path${extension}`;
}

export function codexImageFilesFromItem(item, {
  maximumBytes = 7_500_000,
  maximumAttachments = 10,
} = {}) {
  const files = [];
  const skipped = [];
  const itemName = safeItemName(item?.id);
  const payloads = imagePayloadsFromItem(item);
  for (let index = 0; index < payloads.length; index += 1) {
    if (files.length >= maximumAttachments) {
      skipped.push({ index, reason: `Discord添付数上限 ${maximumAttachments} 件を超えています。` });
      continue;
    }
    const payload = payloads[index];
    try {
      const buffer = decodeBase64Image(payload.data, maximumBytes);
      const extension = IMAGE_MIME_EXTENSIONS.get(payload.mimeType);
      files.push({
        index,
        name: `codex-image-${itemName}-${index + 1}${extension}`,
        mimeType: payload.mimeType,
        size: buffer.length,
        sha256: createHash('sha256').update(buffer).digest('hex'),
        buffer,
      });
    } catch (error) {
      skipped.push({ index, reason: error.message });
    }
  }
  return { files, skipped };
}
