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
const STATES = new Set(['pending', 'release-claimed', 'superseded', ...OPEN_STATES]);
export const DESKTOP_PACKAGE_FAMILY = 'OpenAI.Codex_2p2nqsd0c76g0';

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
  constructor({ directory, codex, binding, isBusy, log = () => {} }) {
    Object.assign(this, { directory, codex, binding, isBusy, log });
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
      if (OPEN_STATES.includes(existing.state)) return false;
      // A replayed notification cannot replace more recent work or reset a release claim.
      if (turnId <= existing.turnId) return false;
    }
    this.#write({ threadId, turnId, itemId: item.id, channelId: binding.channelId, generation }, 'pending');
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
        if (record?.generation !== generation || !['pending', 'release-claimed'].includes(record.state)) continue;
        if (await this.#advance(record)) return; // One visible navigation per existing sync cycle.
      } catch {
        this.log('browser-init-check-failed', { threadId });
      }
    }
  }

  async #advance(record) {
    const { threadId, turnId, itemId, channelId, generation } = record;
    const stillCurrent = () => {
      const binding = this.binding(threadId);
      const latest = this.#read(threadId);
      return eligibleBinding(binding) && binding.channelId === channelId
        && latest?.generation === generation && latest?.turnId === turnId && latest?.state === record.state
        && this.codex.browserInitializationGeneration() === generation && !this.isBusy(threadId);
    };
    if (!stillCurrent()) return false;
    const canAdvance = (thread) => thread?.id === threadId && thread.ephemeral === false
      && !thread.parentThreadId && LOCAL_SOURCES.has(thread.source)
      && thread.path && !/[\\/]archived_sessions[\\/]/i.test(thread.path)
      && (thread.status?.type === 'notLoaded'
        || (thread.status?.type === 'idle' && record.state === 'pending' && this.codex.isSubscribed(threadId)));
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
      this.#write(record, 'release-claimed');
      // Release only this Bridge connection. Desktop or another client may
      // still own the loaded task; wait for the server to report notLoaded.
      await this.codex.releaseBrowserInitializationSubscription(threadId, generation);
      return false;
    }
    if (thread.status?.type !== 'notLoaded') return false;
    const outcome = await this.codex.prepareDesktopThread(threadId);
    if (outcome !== 'opening') return false;
    if (stillCurrent()) this.#write(record, 'handed-off');
    return true;
  }
}
