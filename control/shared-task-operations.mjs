import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { AppServerClient } from '../discord-bridge/src/app-server-client.mjs';
import { validateLoopbackEndpoint } from './codex-shared.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Shared source for new operations. Historical maintenance jobs and their pinned
// implementations remain untouched under local state/; no restart is dispatched here.
export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}

export function saveJson(file, value) {
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const fd = fs.openSync(temporary, 'wx');
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  try { fs.renameSync(temporary, file); }
  finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}

export function deliveryFor(threadId, activeTurn, message) {
  const input = [{ type: 'text', text: message, text_elements: [] }];
  return activeTurn
    ? ['turn/steer', { threadId, expectedTurnId: activeTurn.id, input }]
    : ['turn/start', { threadId, input }];
}

export async function connectCanonical({ requestTimeoutMs = 300_000 } = {}) {
  const state = readJson(path.join(repository, 'launcher/state/current.json'));
  const endpoint = validateLoopbackEndpoint(state.websocketUrl);
  if (!state.desktopConnectionVerified) throw new Error('Canonical Desktop connection is not verified.');
  const client = new AppServerClient(endpoint, { requestTimeoutMs });
  try { await client.connect(); return client; }
  catch (error) { client.close(); throw error; }
}

export async function listPages(client, method, params) {
  const rows = [], seen = new Set();
  let cursor;
  do {
    const page = await client.call(method, { ...params, limit: 100, ...(cursor ? { cursor } : {}) });
    rows.push(...page.data);
    cursor = page.nextCursor;
    if (cursor && seen.has(cursor)) throw new Error(`${method} repeated a pagination cursor.`);
    if (cursor) seen.add(cursor);
  } while (cursor);
  return rows;
}

export async function taskSnapshot(client, ownId) {
  const listed = await listPages(client, 'thread/list', { archived: false });
  const loadedRows = await listPages(client, 'thread/loaded/list', {});
  const loadedIds = [...new Set(loadedRows.map(row => typeof row === 'string' ? row : row.id))];
  const loaded = await Promise.all(loadedIds.map(async id =>
    (await client.call('thread/read', { threadId: id, includeTurns: false })).thread));
  const own = (await client.call('thread/read', { threadId: ownId, includeTurns: false })).thread;
  if (own.id !== ownId) throw new Error('Owning task identity mismatch.');
  const turns = await client.call('thread/turns/list', {
    threadId: ownId, limit: 10, sortDirection: 'desc', itemsView: 'notLoaded',
  });
  const otherActive = [...new Set([...listed, ...loaded]
    .filter(row => row.id !== ownId && row.status?.type === 'active').map(row => row.id))];
  return { own, activeTurn: turns.data.find(turn => turn.status === 'inProgress') ?? null,
    otherActive, loadedCount: loadedIds.length };
}
