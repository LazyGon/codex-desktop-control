// Shared operational IO. Neither hashes nor these records grant Product authority.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
export const sha = b => crypto.createHash('sha256').update(b).digest('hex');
export const canonical = x => JSON.stringify(x, (_, v) => v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
export const insist = (ok, reason) => { if (!ok) throw Error(reason); };
export function pin(file) { const b = fs.readFileSync(file); return {file, sha256: sha(b), byteLength: b.length}; }
export function checkedBytes(p) {
  insist(p && /^[0-9a-f]{64}$/.test(p.sha256) && Number.isSafeInteger(p.byteLength), 'PIN_SHAPE');
  const b = fs.readFileSync(p.file);
  insist(sha(b) === p.sha256 && b.length === p.byteLength, 'PIN_DRIFT'); return b;
}
export const checkedJson = p => JSON.parse(checkedBytes(p));
export function exclusiveBytes(file, bytes) {
  const fd = fs.openSync(file, 'wx');
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  insist(fs.readFileSync(file).equals(bytes), 'WRITE_READBACK'); return pin(file);
}
export const exclusiveJson = (file, value) => exclusiveBytes(file, Buffer.from(canonical(value) + '\n'));
export function updateJson(file, value, previousPin) {
  insist(path.resolve(previousPin.file) === path.resolve(file), 'UPDATE_TARGET'); checkedBytes(previousPin);
  const temp = file + '.' + crypto.randomUUID() + '.tmp';
  exclusiveJson(temp, value); checkedBytes(previousPin); fs.renameSync(temp, file); return pin(file);
}
export function journalState(dir) {
  const names = fs.readdirSync(dir).filter(f => /^\d{6}\.json$/.test(f)).sort();
  let previous = null, last = null;
  for (let i = 0; i < names.length; i++) {
    const file = path.join(dir, names[i]), b = fs.readFileSync(file), r = JSON.parse(b);
    insist(Number(names[i].slice(0, 6)) === i && r.sequence === i && r.previousRecordSha256 === previous,
      'SESSION_CHAIN'); last = r; previous = sha(b);
  }
  return {last, previous, count: names.length};
}
export function appendJournal(dir, record, expectedTip) {
  const state = journalState(dir);
  insist(state.previous === expectedTip, 'SESSION_TIP_CHANGED');
  insist(state.count < 1000000, 'SESSION_SEQUENCE_LIMIT');
  return exclusiveJson(path.join(dir, String(state.count).padStart(6, '0') + '.json'), {
    ...record, sequence: state.count, previousRecordSha256: state.previous, at: new Date().toISOString()});
}
