import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { atomicWriteJson } from './util.mjs';

function validateState(value, guildId) {
  if (!value || value.guildId !== guildId) {
    throw new Error('Discord state guild does not match the configured guild; refusing to reset state.');
  }
  if (!Number.isInteger(value.schemaVersion) || value.schemaVersion < 1 || value.schemaVersion > 8) {
    throw new Error('Unsupported Discord state schema; refusing to reset state.');
  }
  for (const key of ['bindings', 'infrastructure']) {
    if (!value[key] || typeof value[key] !== 'object' || Array.isArray(value[key])) {
      throw new Error('Discord state collections are unreadable; refusing to reset state.');
    }
  }
  return value;
}

const parse = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));

export function readStateSnapshot(file, guildId) {
  let originalError;
  try {
    // A readable foreign guild or newer schema is not a corruption fallback.
    const value = parse(file);
    return { value: validateState(value, guildId), recovered: false };
  } catch (error) {
    if (!(error instanceof SyntaxError) && error.code !== 'ENOENT') throw error;
    originalError = error;
  }
  for (const backup of [`${file}.bak`, `${file}.bak.older`]) {
    let value;
    try { value = validateState(parse(backup), guildId); } catch { continue; }
    if (originalError.code !== 'ENOENT') {
      const preserved = `${file}.corrupt.${randomUUID()}`;
      fs.copyFileSync(file, preserved, fs.constants.COPYFILE_EXCL);
      const fd = fs.openSync(preserved, 'r+');
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    }
    return { value, recovered: true };
  }
  if (originalError.code === 'ENOENT') return { value: undefined, recovered: false };
  throw new Error('Discord state could not be read; refusing to reset visibility or recreate mirrors.', { cause: originalError });
}

export function writeStateSnapshot(file, value, retainPrimary = true) {
  if (retainPrimary && fs.existsSync(file)) {
    const backup = `${file}.bak`;
    const temporary = `${backup}.${randomUUID()}.tmp`;
    // The writer replaces files rather than modifying their contents. Retaining
    // the old inode avoids copying a large snapshot for each streamed update.
    fs.linkSync(file, temporary);
    try {
      if (fs.existsSync(backup)) fs.renameSync(backup, `${backup}.older`);
      fs.renameSync(temporary, backup);
      const fd = fs.openSync(backup, 'r+');
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }
  atomicWriteJson(file, value, { space: 0, flush: true });
}
