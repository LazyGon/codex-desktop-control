import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { atomicWriteJson } from './util.mjs';

const HOST_UNAVAILABLE = 'The browser access host is unavailable';
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const LOCAL_SOURCES = new Set(['vscode', 'cli', 'exec', 'appServer']);
const FINISHED = new Set(['completed', 'failed']);
const OPEN_STATES = ['handed-off', 'open-claimed', 'dispatched', 'unknown'];
const ARCHIVE_STATES = ['archive-claimed', 'archived', 'unarchive-claimed', 'restored'];
const ADVANCE_STATES = ['pending', 'release-claimed', 'released', 'unarchive-claimed', 'restored'];
const STATES = new Set([...ADVANCE_STATES, ...ARCHIVE_STATES, 'superseded', ...OPEN_STATES]);
const archivedPath = (value) => typeof value === 'string' && /[\\/]archived_sessions[\\/]/i.test(value);
export const DESKTOP_PACKAGE_FAMILY = 'OpenAI.Codex_2p2nqsd0c76g0';

function sameSessionPath(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const normalize = (value) => path.win32.normalize(value.startsWith('\\\\?\\UNC\\')
    ? '\\\\' + value.slice(8)
    : value.startsWith('\\\\?\\') ? value.slice(4) : value);
  return normalize(left) === normalize(right);
}

function computerUseCode(item) {
  if (item?.type !== 'mcpToolCall' || item.server !== 'cua_repl' || item.tool !== 'js') return null;
  return typeof item.arguments?.code === 'string' ? item.arguments.code.trim() : null;
}

function browserSelector(code) {
  return /\bcua\.(getTab|getBrowser|createBrowserTab)\s*\(/.test(code ?? '');
}

function inventoryCall(code) {
  return /^(?:await )?cua\.getState\(\);?$/.test(code ?? '');
}

export function browserHostUnavailable(item) {
  const code = computerUseCode(item);
  if (!code) return false;
  const content = item.result?.content;
  if (item.status === 'failed' && browserSelector(code)) {
    return item.error?.message === HOST_UNAVAILABLE || (content?.length === 1
      && content[0]?.type === 'text' && content[0].text?.trim() === HOST_UNAVAILABLE);
  }
  // A bare inventory call can return the host error as data even if the tool
  // itself completed. Never scan arbitrary code output or page text for it.
  return item.status === 'completed' && inventoryCall(code) && content?.some((entry) => (
    entry.type === 'text' && entry.text?.split(/\r?\n/).some((line) => (
      line.trim() === `Browsers: Error: ${HOST_UNAVAILABLE}`
    ))
  )) === true;
}

export function browserFailureItem(turn) {
  let failure = null;
  for (const item of turn?.items ?? []) {
    if (browserHostUnavailable(item)) failure = item;
    else if (item.status === 'completed') {
      const code = computerUseCode(item);
      if (browserSelector(code) || inventoryCall(code)) failure = null;
    }
  }
  return failure;
}

export async function openDesktopThread(threadId) {
  if (process.platform !== 'win32' || !UUID.test(threadId)) throw new Error('Invalid Desktop thread activation.');
  const script = fileURLToPath(new URL('./open-desktop-browser-thread.ps1', import.meta.url));
  const powershell = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  await promisify(execFile)(powershell, [
    '-NoProfile', '-NonInteractive', '-STA', '-File', script, '-ThreadId', threadId,
  ], { windowsHide: true });
}

function eligibleBinding(binding) {
  return Boolean(binding?.channelId && !binding.archived && !binding.hidden && !binding.isSubagent);
}

export class BrowserInitialization {
  constructor({ directory, codex, binding, isBusy, canArchive = () => true, clock = Date.now, log = () => {} }) {
    Object.assign(this, { directory, codex, binding, isBusy, canArchive, clock, log });
    this.archiveCompletion = null;
  }

  #recordPath(threadId) {
    return path.join(this.directory, `${threadId}.json`);
  }

  #read(threadId) {
    let record;
    try { record = JSON.parse(fs.readFileSync(this.#recordPath(threadId), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (record?.threadId !== threadId || !UUID.test(record.turnId) || !STATES.has(record.state)
      || typeof record.generation !== 'string' || !record.itemId || !record.channelId) {
      throw new Error('Invalid browser initialization receipt.');
    }
    return record;
  }

  #write(record, state) {
    const next = { ...record, state };
    atomicWriteJson(this.#recordPath(record.threadId), next, { flush: true });
    this.log(`browser-init-${state}`, { threadId: next.threadId, turnId: next.turnId });
    return next;
  }

  observe({ threadId, turnId, item }) {
    if (!UUID.test(threadId) || !UUID.test(turnId) || typeof item?.id !== 'string' || !item.id
      || !browserHostUnavailable(item)) return false;
    const binding = this.binding(threadId);
    const generation = this.codex.browserInitializationGeneration?.();
    if (!eligibleBinding(binding) || !generation) return false;
    const existing = this.#read(threadId);
    if (existing?.generation === generation) {
      if (OPEN_STATES.includes(existing.state) || ARCHIVE_STATES.includes(existing.state)) return false;
      // A replayed notification cannot replace more recent work or reset a release claim.
      if (turnId <= existing.turnId) return false;
    }
    this.#write({ threadId, turnId, itemId: item.id, channelId: binding.channelId, generation,
      observedAt: this.clock() }, 'pending');
    return true;
  }

  async run() {
    const generation = this.codex.browserInitializationGeneration?.();
    if (!generation) return;
    let filenames;
    try { filenames = fs.readdirSync(this.directory); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const filename of filenames) {
      const threadId = filename.slice(0, -5);
      if (!filename.endsWith('.json') || !UUID.test(threadId)) continue;
      try {
        const record = this.#read(threadId);
        if (record?.generation !== generation || !ADVANCE_STATES.includes(record.state)) continue;
        if (await this.#advance(record)) return; // One visible navigation per existing sync cycle.
      } catch {
        this.log('browser-init-check-failed', { threadId });
      }
    }
  }

  #sameEpisode(record) {
    const { threadId, turnId, channelId, generation } = record;
    const binding = this.binding(threadId);
    const latest = this.#read(threadId);
    return eligibleBinding(binding) && binding.channelId === channelId
      && latest?.generation === generation && latest?.turnId === turnId && latest?.state === record.state
      && this.codex.browserInitializationGeneration() === generation;
  }

  async #advance(record) {
    const { threadId, turnId, itemId, generation } = record;
    const stillCurrent = () => this.#sameEpisode(record) && !this.isBusy(threadId);
    if (!stillCurrent()) return false;
    const canAdvance = (thread) => thread?.id === threadId && thread.ephemeral === false
      && !thread.parentThreadId && LOCAL_SOURCES.has(thread.source)
      && thread.path && !archivedPath(thread.path)
      && (thread.status?.type === 'notLoaded'
        || (thread.status?.type === 'idle' && ['pending', 'released'].includes(record.state)));
    if (!canAdvance(await this.codex.readThreadMetadata(threadId)) || !stillCurrent()) return false;
    const preview = (await this.codex.recentTurns(threadId, { limit: 1, itemsView: 'notLoaded' })).data?.[0];
    if (!stillCurrent() || !preview || preview.status === 'inProgress') return false;
    if (preview.id !== turnId || !FINISHED.has(preview.status)) {
      this.#write(record, 'superseded');
      return false;
    }
    const turn = (await this.codex.recentTurns(threadId, { limit: 1 })).data?.[0];
    if (!stillCurrent() || turn?.id !== turnId || !FINISHED.has(turn.status)) return false;
    if (!browserFailureItem(turn)
      || !turn.items?.some((item) => item.id === itemId && browserHostUnavailable(item))) {
      this.#write(record, 'superseded');
      return false;
    }
    const thread = await this.codex.readThreadMetadata(threadId);
    if (!stillCurrent() || !canAdvance(thread)) return false;
    if (thread.status?.type === 'idle' && record.state === 'pending' && this.codex.isSubscribed(threadId)) {
      const claim = this.#write(record, 'release-claimed');
      const status = await this.codex.releaseBrowserInitializationSubscription(threadId, generation);
      if (['unsubscribed', 'notSubscribed', 'notLoaded'].includes(status) && this.#sameEpisode(claim)) {
        return this.#advance(this.#write({ ...claim, releasedAt: this.clock() }, 'released'));
      }
      return false;
    }
    if (thread.status?.type === 'notLoaded') {
      if (record.state === 'unarchive-claimed') {
        // Reconcile a verified restore without repeating either mutation.
        // The Windows store can return the same path with or without \\?\.
        if (!archivedPath(record.archivedPath) || !sameSessionPath(thread.path, record.originalPath)) return false;
        return this.#handoff(this.#write(record, 'restored'));
      }
      return this.#handoff(record);
    }
    if (thread.canAcceptDirectInput !== true || this.codex.isSubscribed(threadId) || !this.canArchive(threadId)) return false;
    const grace = await this.codex.browserUnloadGraceMs();
    if (!stillCurrent() || !Number.isSafeInteger(grace)) return false;
    const observedAt = record.releasedAt ?? record.observedAt ?? fs.statSync(this.#recordPath(threadId)).mtimeMs;
    // The owner elected to wait only for a few seconds (single-digit seconds).
    // The verified server's normal 60-second grace does not fit that policy.
    if (grace < 10_000 && this.clock() < observedAt + grace) return false;
    return this.#archiveAndRestore(record, thread.path, stillCurrent);
  }

  async #handoff(record) {
    if (!this.#sameEpisode(record)) return false;
    const outcome = await this.codex.prepareDesktopThread(record.threadId);
    if (outcome !== 'opening') return false;
    if (this.#sameEpisode(record)) this.#write(record, 'handed-off');
    return true;
  }

  async #archiveAndRestore(record, originalPath, stillCurrent) {
    const { threadId, turnId } = record;
    if (this.archiveCompletion || !this.canArchive(threadId)) return false;
    const operation = Promise.resolve().then(() => this.codex.withBrowserArchive(threadId, async () => {
      // An archived descendant is also affected by restore. Include it in the
      // related-task preflight rather than treating the round trip as one row.
      const [goal, terminals, related] = await Promise.all([
        this.codex.getGoal(threadId), this.codex.listBackgroundTerminals(threadId, { strict: true }),
        this.codex.browserArchiveHasRelations(threadId),
      ]);
      if (goal?.goal !== null || !Array.isArray(terminals) || terminals.length || related !== false) return false;
      const latest = (await this.codex.recentTurns(threadId, { limit: 1, itemsView: 'notLoaded' })).data?.[0];
      const live = await this.codex.readThreadMetadata(threadId);
      if (!stillCurrent() || !this.canArchive(threadId) || latest?.id !== turnId || !FINISHED.has(latest.status)
        || live?.id !== threadId || !sameSessionPath(live.path, originalPath) || live.status?.type !== 'idle'
        || live.canAcceptDirectInput !== true || this.codex.isSubscribed(threadId)) return false;

      // Record each irreversible request before dispatch. An interrupted or
      // uncertain attempt is never replayed or automatically reversed.
      let receipt = this.#write({ ...record, originalPath }, 'archive-claimed');
      const accepted = await this.codex.archiveThread(threadId, { browserRecovery: true });
      if (accepted?.threadId !== threadId || !this.#sameEpisode(receipt)) return true;
      const archived = await this.codex.readThreadMetadata(threadId);
      if (!this.#sameEpisode(receipt) || archived?.id !== threadId || archived.status?.type !== 'notLoaded'
        || !archivedPath(archived.path) || path.win32.basename(archived.path) !== path.win32.basename(originalPath)) {
        this.log('browser-init-archive-unconfirmed', { threadId, turnId });
        return true;
      }
      receipt = this.#write({ ...receipt, archivedPath: archived.path }, 'archived');
      receipt = this.#write(receipt, 'unarchive-claimed');
      const response = await this.codex.unarchiveThread(threadId, { browserRecovery: true });
      if (response?.thread?.id !== threadId || !this.#sameEpisode(receipt)) return true;
      const restored = await this.codex.readThreadMetadata(threadId);
      if (!this.#sameEpisode(receipt) || restored?.id !== threadId || !sameSessionPath(restored.path, originalPath)) {
        this.log('browser-init-restore-unconfirmed', { threadId, turnId });
        return true;
      }
      receipt = this.#write(receipt, 'restored');
      if (restored.status?.type === 'notLoaded') await this.#handoff(receipt);
      return true;
    }));
    this.archiveCompletion = operation;
    try { return await operation; }
    finally { this.archiveCompletion = null; }
  }
}
