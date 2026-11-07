import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicWriteJson } from './util.mjs';

const THREAD_ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const LOCAL_SOURCES = new Set(['vscode', 'cli', 'exec', 'appServer']);
const LOADED = new Set(['idle', 'active', 'systemError']);
const DESKTOP_MCP = 'desktop-mcp';

export class DesktopThreadPendingError extends Error {
  constructor() {
    super('Desktop でタスクを読み込み中です。まだ送信していません。');
    this.code = 'DESKTOP_THREAD_PENDING';
  }
}

export function desktopResumeSucceeded(line, threadId, notBefore) {
  const match = /^(\S+) info \[AppServerConnection\] response_routed (.*)$/.exec(line);
  if (!match) return false;
  const fields = new Map(match[2].split(' ').map((field) => field.split('=', 2)));
  const completedAt = Date.parse(match[1]);
  const durationMs = Number(fields.get('durationMs'));
  return fields.get('method') === 'thread/resume' && fields.get('conversationId') === threadId
    && fields.get('errorCode') === 'null' && fields.get('hadPending') === 'true'
    && (!fields.has('hostId') || fields.get('hostId') === 'local')
    && Number.isFinite(durationMs) && durationMs >= 0 && completedAt - durationMs >= notBefore;
}

function daysFor(...times) {
  const days = new Set();
  for (const time of times) {
    const date = new Date(time);
    if (!Number.isFinite(date.getTime())) continue;
    days.add(date.toISOString().slice(0, 10).replaceAll('-', '/'));
    days.add([date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'),
      String(date.getDate()).padStart(2, '0')].join('/'));
  }
  return days;
}

export function desktopResumeLogs(runtime, now = Date.now()) {
  const files = new Map();
  for (const root of runtime.logRoots) for (const day of daysFor(runtime.startedAt, now)) {
    const directory = path.join(root, day);
    let entries;
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    for (const entry of entries) {
      const pid = /^codex-desktop-[a-f0-9-]+-(\d+)-t0-[^/\\]+\.log$/.exec(entry.name)?.[1];
      if (!entry.isFile() || !runtime.desktopPids.includes(Number(pid))) continue;
      const file = path.join(directory, entry.name);
      const stat = fs.statSync(file, { throwIfNoEntry: false });
      if (!stat?.isFile()) continue;
      files.set(file, { pid: Number(pid), size: stat.size, identity: `${stat.dev}:${stat.ino}:${stat.birthtimeMs}` });
    }
  }
  return files;
}

async function readResume(file, start, size, threadId, notBefore) {
  let cursor = start;
  let partial = Buffer.alloc(0);
  if (start >= size) return { cursor, found: false };
  for await (const chunk of fs.createReadStream(file, { start, end: size - 1 })) {
    const bytes = partial.length ? Buffer.concat([partial, chunk]) : chunk;
    let startOfLine = 0;
    for (let end = bytes.indexOf(10); end !== -1; end = bytes.indexOf(10, startOfLine)) {
      const line = bytes.toString('utf8', startOfLine, end).trimEnd();
      cursor += end + 1 - startOfLine;
      if (desktopResumeSucceeded(line, threadId, notBefore)) return { cursor, found: true };
      startOfLine = end + 1;
    }
    partial = bytes.subarray(startOfLine);
  }
  return { cursor, found: false };
}

export class DesktopFirst {
  #inFlight = new Map();
  #dispatch = null;
  #waiting = new Set();
  #scannedGeneration = null;

  constructor({ directory, runtime, readThread, prepareNavigation, log = () => {}, clock = Date.now }) {
    Object.assign(this, { directory, runtime, readThread, prepareNavigation, log, clock });
  }

  prepare(threadId, { allowOpen = true } = {}) {
    if (!THREAD_ID.test(threadId)) return Promise.resolve('ready');
    const existing = this.#inFlight.get(threadId);
    if (existing) return existing;
    const work = this.#prepare(threadId, allowOpen).finally(() => this.#inFlight.delete(threadId));
    this.#inFlight.set(threadId, work);
    return work;
  }

  async reconcile() {
    const runtime = this.runtime();
    if (!runtime) return;
    if (this.#scannedGeneration !== runtime.generation) {
      let names;
      try { names = fs.readdirSync(this.directory); }
      catch (error) { if (error.code !== 'ENOENT') throw error; names = []; }
      this.#waiting.clear();
      for (const name of names) {
        const id = name.slice(0, -5);
        if (!name.endsWith('.json') || !THREAD_ID.test(id)) continue;
        try {
          const record = this.#read(id);
          if (record?.generation === runtime.generation && record.phase === 'waiting') this.#waiting.add(id);
        } catch { this.log('desktop-first-check-failed', { threadId: id }); }
      }
      this.#scannedGeneration = runtime.generation;
    }
    for (const id of this.#waiting) {
      if (this.runtime()?.generation !== runtime.generation) break;
      try { await this.prepare(id, { allowOpen: false }); }
      catch { this.log('desktop-first-check-failed', { threadId: id }); }
    }
  }

  #file(threadId) { return path.join(this.directory, `${threadId}.json`); }

  isWaiting(threadId, generation) {
    const record = this.#read(threadId);
    return record?.generation === generation && record.phase === 'waiting';
  }

  #read(threadId) {
    let record;
    try { record = JSON.parse(fs.readFileSync(this.#file(threadId), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (record.threadId !== threadId || !['waiting', 'confirmed'].includes(record.phase)
      || !Array.isArray(record.offsets) || !Array.isArray(record.desktopPids)
      || !record.attemptId || !record.generation || !Number.isFinite(record.notBefore)) {
      throw new Error('Invalid Desktop load receipt.');
    }
    return record;
  }

  #save(record) {
    atomicWriteJson(this.#file(record.threadId), record, { flush: true });
    if (record.phase === 'waiting') this.#waiting.add(record.threadId);
    else this.#waiting.delete(record.threadId);
  }

  async #prepare(threadId, allowOpen) {
    const runtime = this.runtime();
    if (!runtime) return 'disabled';
    const sameRuntime = () => this.runtime()?.generation === runtime.generation;
    const thread = await this.readThread(threadId);
    if (thread?.id !== threadId || !sameRuntime()) return 'waiting';
    if (thread.ephemeral !== false || thread.parentThreadId || !LOCAL_SOURCES.has(thread.source)) return 'ready';
    if (!thread.path || /[\\/]archived_sessions[\\/]/i.test(thread.path)) throw new Error('Desktop cannot open this local task.');
    const record = this.#read(threadId);
    const waiting = record?.generation === runtime.generation && record.phase === 'waiting';
    if (waiting) {
      const confirmed = await this.#confirm(record, runtime, sameRuntime);
      if (confirmed === 'ready' || record.transport === DESKTOP_MCP || !allowOpen
        || thread.status?.type !== 'notLoaded') return confirmed;
    }
    if (LOADED.has(thread.status?.type)) return 'ready';
    if (thread.status?.type !== 'notLoaded' || !allowOpen) return 'waiting';
    if (this.#dispatch) return 'waiting';

    // MCP startup is independent of the outbox. Claim only when it is ready,
    // so a failed handshake cannot consume the one navigation attempt.
    this.#dispatch = this.#navigate(threadId, runtime, sameRuntime)
      .catch(() => this.log('desktop-first-api-unavailable', { threadId }))
      .finally(() => { this.#dispatch = null; });
    return 'waiting';
  }

  async #navigate(threadId, runtime, sameRuntime) {
    if (!sameRuntime()) return;
    const open = await this.prepareNavigation();
    if (!sameRuntime()) return;
    const thread = await this.readThread(threadId);
    if (thread?.id !== threadId || thread.status?.type !== 'notLoaded' || thread.ephemeral !== false
      || thread.parentThreadId || !LOCAL_SOURCES.has(thread.source)
      || !thread.path || /[\\/]archived_sessions[\\/]/i.test(thread.path) || !sameRuntime()) return;
    const previous = this.#read(threadId);
    const waiting = previous?.generation === runtime.generation && previous.phase === 'waiting';
    if (waiting && previous.transport === DESKTOP_MCP) return;
    const notBefore = this.clock();
    const baseline = desktopResumeLogs(runtime, notBefore);
    if (!baseline.size) return;
    const next = {
      threadId, generation: runtime.generation, attemptId: randomUUID(), notBefore,
      phase: 'waiting', transport: DESKTOP_MCP, desktopPids: runtime.desktopPids,
      offsets: [...baseline].map(([file, { size, identity }]) => [file, { cursor: size, identity }]),
      // A cold task can use the new transport once. Preserve the earlier
      // URI claim; this does not replay the Discord input or the URI.
      ...(previous?.previousUriAttempt || waiting
        ? { previousUriAttempt: previous.previousUriAttempt ?? previous } : {}),
    };
    // Persist the attempt before navigation. A restart can check
    // evidence but never repeats a dispatch whose outcome might be unknown.
    this.#save(next);
    const details = { threadId, attemptId: next.attemptId, transport: DESKTOP_MCP };
    this.log('desktop-first-claimed', details);
    try {
      const opened = await open(threadId);
      this.log(opened ? 'desktop-first-api-navigated' : 'desktop-first-api-not-confirmed', details);
    } catch {
      this.log('desktop-first-api-unknown', details);
    }
  }

  async #confirm(record, runtime, sameRuntime) {
    const { threadId, notBefore, attemptId } = record;
    const offsets = new Map(record.offsets);
    const eligiblePids = runtime.desktopPids.filter((pid) => record.desktopPids.includes(pid));
    let resumePid = eligiblePids.includes(record.resumePid) ? record.resumePid : null;
    for (const [file, { pid, size, identity }] of resumePid ? [] : desktopResumeLogs({ ...runtime, desktopPids: eligiblePids })) {
      const previous = offsets.get(file);
      const start = previous?.identity === identity ? previous.cursor : 0;
      if (!Number.isSafeInteger(start) || start < 0 || start > size) continue;
      const result = await readResume(file, start, size, threadId, notBefore);
      if (result.cursor !== start || !previous) offsets.set(file, { cursor: result.cursor, identity });
      if (result.found) { resumePid = pid; break; }
    }
    const next = { ...record, offsets: [...offsets], resumePid };
    if (resumePid && sameRuntime()) {
      const thread = await this.readThread(threadId);
      if (thread?.id === threadId && LOADED.has(thread.status?.type) && sameRuntime()
        && this.runtime()?.desktopPids.includes(resumePid)) {
        this.#save({ ...next, phase: 'confirmed' });
        this.log('desktop-first-confirmed', { threadId, attemptId });
        return 'ready';
      }
    }
    if (resumePid !== (record.resumePid ?? null) || JSON.stringify(next.offsets) !== JSON.stringify(record.offsets)) {
      this.#save(next);
    }
    return 'opening';
  }
}
