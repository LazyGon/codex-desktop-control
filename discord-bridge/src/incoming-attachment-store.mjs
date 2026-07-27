import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { safeAttachmentName } from './local-file-share.mjs';

const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

function safeIdentifier(value, label) {
  const normalized = String(value ?? '').trim();
  if (!/^[a-z0-9_-]{1,128}$/i.test(normalized)) {
    throw new Error(`${label}が安全な識別子ではありません。`);
  }
  return normalized;
}

function incomingFileName(value) {
  let name = safeAttachmentName(String(value ?? '').trim() || 'attachment');
  name = name.replace(/[. ]+$/g, '');
  if (!name) name = 'attachment';
  if (WINDOWS_RESERVED_NAME.test(name)) name = `_${name}`;
  return name;
}

function declaredAttachmentSize(attachment) {
  const size = Number(attachment?.size);
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new Error(`添付ファイル ${attachment?.name ?? '(unknown)'} のサイズが不明です。`);
  }
  return size;
}

export class IncomingAttachmentStore {
  constructor(rootPath, {
    maxFileBytes = 512_000_000,
    maxTotalBytes = 512_000_000,
    maxCount = 10,
    timeoutMs = 300_000,
    fetchImpl = fetch,
  } = {}) {
    this.rootPath = path.resolve(rootPath);
    this.maxFileBytes = maxFileBytes;
    this.maxTotalBytes = maxTotalBytes;
    this.maxCount = maxCount;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
  }

  async store({ threadId, sourceId, attachments }) {
    const values = [...(attachments ?? [])];
    if (values.length > this.maxCount) {
      throw new Error(`添付ファイルは1投稿につき${this.maxCount}件以下にしてください。`);
    }
    const declaredSizes = values.map(declaredAttachmentSize);
    for (let index = 0; index < values.length; index += 1) {
      if (declaredSizes[index] > this.maxFileBytes) {
        throw new Error(`添付ファイル ${values[index].name} は上限 ${this.maxFileBytes} bytes を超えています。`);
      }
    }
    const declaredTotal = declaredSizes.reduce((sum, size) => sum + size, 0);
    if (declaredTotal > this.maxTotalBytes) {
      throw new Error(`添付ファイルの合計は ${this.maxTotalBytes} bytes 以下にしてください。`);
    }

    const safeThreadId = safeIdentifier(threadId, 'Codex task ID');
    const safeSourceId = safeIdentifier(sourceId, 'Discord message ID');
    const records = [];
    let actualTotal = 0;
    for (let index = 0; index < values.length; index += 1) {
      const attachment = values[index];
      const attachmentId = safeIdentifier(
        attachment.id ?? `attachment-${index + 1}`,
        'Discord attachment ID',
      );
      const name = incomingFileName(attachment.name);
      const directory = path.join(this.rootPath, safeThreadId, safeSourceId, attachmentId);
      const destination = path.join(directory, name);
      await fs.promises.mkdir(directory, { recursive: true });

      let stat = await fs.promises.stat(destination).catch(() => null);
      if (!stat?.isFile() || stat.size !== declaredSizes[index]) {
        const response = await this.fetchImpl(attachment.url, {
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (!response.ok) {
          throw new Error(`添付ファイル ${attachment.name} を取得できませんでした: HTTP ${response.status}`);
        }
        const contentLength = Number(response.headers.get('content-length'));
        if (Number.isFinite(contentLength) && contentLength > this.maxFileBytes) {
          throw new Error(`添付ファイル ${attachment.name} は受信上限を超えています。`);
        }
        if (!response.body) throw new Error(`添付ファイル ${attachment.name} の内容が空です。`);
        const temporary = path.join(directory, `.${name}.${process.pid}.${randomUUID()}.tmp`);
        let receivedBytes = 0;
        const limiter = new Transform({
          transform: (chunk, encoding, callback) => {
            receivedBytes += chunk.length;
            if (receivedBytes > this.maxFileBytes) {
              callback(new Error(`添付ファイル ${attachment.name} は受信上限を超えています。`));
              return;
            }
            if (actualTotal + receivedBytes > this.maxTotalBytes) {
              callback(new Error(`添付ファイルの実サイズ合計は ${this.maxTotalBytes} bytes 以下にしてください。`));
              return;
            }
            callback(null, chunk);
          },
        });
        try {
          await pipeline(
            Readable.fromWeb(response.body),
            limiter,
            fs.createWriteStream(temporary, { flags: 'wx' }),
          );
          actualTotal += receivedBytes;
          if (stat) await fs.promises.rm(destination, { force: true });
          await fs.promises.rename(temporary, destination);
        } finally {
          await fs.promises.rm(temporary, { force: true }).catch(() => {});
        }
        stat = await fs.promises.stat(destination);
      } else {
        actualTotal += stat.size;
        if (actualTotal > this.maxTotalBytes) {
          throw new Error(`添付ファイルの実サイズ合計は ${this.maxTotalBytes} bytes 以下にしてください。`);
        }
      }

      records.push({
        id: attachmentId,
        name,
        originalName: String(attachment.name ?? name),
        path: destination,
        size: stat.size,
        contentType: attachment.contentType ?? null,
      });
    }
    return records;
  }
}
