import fs from 'node:fs';
import path from 'node:path';
import { readJson, saveJson } from './shared-task-operations.mjs';

export function creditResetStore(directory) {
  const folder = path.join(directory, 'credit-resets');
  fs.mkdirSync(folder, { recursive: true });
  const file = record => path.join(folder, record.idempotencyKey + '.json');
  return {
    records: () => fs.readdirSync(folder).filter(f => f.endsWith('.json')).map(name => {
      const record = readJson(path.join(folder, name));
      if (record?.schemaVersion !== 1 || name !== record.idempotencyKey + '.json'
          || !/^[0-9a-f-]{36}$/i.test(record.idempotencyKey ?? '') || !/^[0-9a-f-]{36}$/i.test(record.authorizationId ?? '')
          || !/^[0-9a-f]{64}$/.test(record.accountHash ?? '') || typeof record.creditId !== 'string' || !record.creditId
          || typeof record.windowIdentity !== 'string' || !record.windowIdentity
          || !['prepared','dispatching','unknown-no-resend','redeemed','already-redeemed','nothing-to-reset','no-credit','cancelled-before-dispatch'].includes(record.phase)) {
        throw new Error('Invalid credit reset journal');
      }
      return record;
    }),
    claim(record) {
      const fd = fs.openSync(file(record), 'wx', 0o600);
      try { fs.writeFileSync(fd, JSON.stringify(record, null, 2) + '\n'); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
    },
    update: record => saveJson(file(record), record),
  };
}
