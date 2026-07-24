import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { randomBytes } from 'node:crypto';

const TIMESTAMP_TEXT_FILE = /^(\d+)\.txt$/;

function timestampFromName(name) {
  const match = TIMESTAMP_TEXT_FILE.exec(name);
  return match ? Number.parseInt(match[1], 10) : null;
}

export class TextTransferStore {
  constructor(directory) {
    this.directory = path.resolve(directory);
    this.lastTimestamp = 0;
    this.initialization = null;
    this.writeTail = Promise.resolve();
  }

  ensureDirectory() {
    this.initialization ??= this.#initialize();
    return this.initialization;
  }

  store(text, requestedTimestamp = Date.now()) {
    const operation = this.writeTail.then(() => this.#store(text, requestedTimestamp));
    this.writeTail = operation.catch(() => {});
    return operation;
  }

  async #initialize() {
    await fs.mkdir(this.directory, { recursive: true });
    const entries = await fs.readdir(this.directory, { withFileTypes: true });
    const timestampFiles = entries
      .map((entry) => ({ entry, timestamp: timestampFromName(entry.name) }))
      .filter(({ entry, timestamp }) => timestamp !== null && (entry.isFile() || entry.isSymbolicLink()))
      .sort((left, right) => right.timestamp - left.timestamp);
    if (timestampFiles[0]) this.lastTimestamp = timestampFiles[0].timestamp;
    for (const { entry } of timestampFiles.slice(1)) {
      await fs.rm(path.join(this.directory, entry.name), { force: true });
    }
    return this.directory;
  }

  async #store(text, requestedTimestamp) {
    if (typeof text !== 'string' || text.length === 0) {
      throw new Error('Transfer text must be a non-empty string.');
    }
    await this.ensureDirectory();
    const numericTimestamp = Number(requestedTimestamp);
    const candidateTimestamp = Number.isFinite(numericTimestamp) && numericTimestamp > 0
      ? Math.trunc(numericTimestamp)
      : Date.now();
    const timestamp = Math.max(candidateTimestamp, this.lastTimestamp + 1);
    const filename = `${timestamp}.txt`;
    const filePath = path.join(this.directory, filename);
    const temporaryPath = path.join(
      this.directory,
      `.${filename}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`,
    );

    try {
      await fs.writeFile(temporaryPath, text, { encoding: 'utf8', flag: 'wx' });
      await fs.rename(temporaryPath, filePath);
      const entries = await fs.readdir(this.directory, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name === filename || timestampFromName(entry.name) === null) continue;
        if (!entry.isFile() && !entry.isSymbolicLink()) continue;
        await fs.rm(path.join(this.directory, entry.name), { force: true });
      }
    } catch (error) {
      await fs.rm(temporaryPath, { force: true }).catch(() => {});
      throw error;
    }

    this.lastTimestamp = timestamp;
    return {
      path: filePath,
      filename,
      timestamp,
      bytes: Buffer.byteLength(text, 'utf8'),
    };
  }
}
