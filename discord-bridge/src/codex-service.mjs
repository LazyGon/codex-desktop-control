import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  APP_SERVER_OPERATION_TIMEOUT_MS,
  AppServerClient,
} from './app-server-client.mjs';
import {
  appendJsonLine,
  completionTextFromSession,
  finalTextFromTurn,
  needsSessionCompletionFallback,
  readJsonIfPresent,
  sleep,
  threadStatusLabel,
} from './util.mjs';
import { isHighVolumeCodexNotification } from './codex-notification-buffer.mjs';
import { inspectDesktopClientOwner, processIsAlive, sharedServerAvailable } from './client-tool-ownership.mjs';
import { forkOwnTurns } from './session-fork-info.mjs';
import { turnTimestampMs } from './recent-history.mjs';
import { DESKTOP_PACKAGE_FAMILY } from './browser-initialization.mjs';
import { DesktopFirst, DesktopThreadPendingError } from './desktop-first.mjs';
import { DesktopNavigation } from './desktop-navigation.mjs';

// All ThreadSourceKind values in the verified App Server's v2 protocol.
const RELATION_SOURCE_KINDS = ['cli', 'vscode', 'exec', 'appServer', 'subAgent', 'subAgentReview',
  'subAgentCompact', 'subAgentThreadSpawn', 'subAgentOther', 'unknown'];

function attachmentValues(attachments) {
  if (!attachments) return [];
  return Array.isArray(attachments) ? attachments : [attachments];
}

function localFileLink(attachment) {
  const name = String(attachment.name ?? path.basename(attachment.path))
    .replaceAll('\\', '\\\\')
    .replaceAll('[', '\\[')
    .replaceAll(']', '\\]');
  const target = String(attachment.path).replaceAll('\\', '/');
  const details = [
    attachment.contentType,
    Number.isSafeInteger(attachment.size) ? `${attachment.size} bytes` : null,
  ].filter(Boolean).join(', ');
  return `- [${name}](<${target}>)${details ? ` (${details})` : ''}`;
}

function textInput(text, attachments = null) {
  const input = [{ type: 'text', text }];
  const localFiles = [];
  for (const attachment of attachmentValues(attachments)) {
    if (attachment?.kind === 'image') {
      input.push({ type: 'image', url: attachment.url });
    } else if (attachment?.kind === 'localImage') {
      input.push({ type: 'localImage', path: attachment.path });
    } else if (attachment?.kind === 'text') {
      input[0].text += `\n\nAttached file: ${attachment.name}\n\n${attachment.text}`;
    } else if (attachment?.kind === 'file' && attachment.path) {
      localFiles.push(attachment);
    }
  }
  if (localFiles.length) {
    input[0].text += `\n\n# Files mentioned by the user:\n${localFiles.map(localFileLink).join('\n')}`;
  }
  return input;
}

export function subscriptionRestoreBindings(bindings) {
  const statusRank = (binding) => binding.taskStatus === 'active' ? 0 : 1;
  const updatedAtMs = (binding) => Date.parse(binding.updatedAt ?? '') || 0;
  return [...bindings]
    .filter((binding) => !binding.archived && !binding.hidden)
    .sort((left, right) => statusRank(left) - statusRank(right)
      || updatedAtMs(right) - updatedAtMs(left));
}

export async function forEachConcurrent(items, maximum, operation) {
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      await operation(items[index], index);
    }
  };
  await Promise.all(Array.from(
    { length: Math.min(Math.max(1, maximum), items.length) },
    () => worker(),
  ));
}

export function threadForSubscriptionRestore(binding, thread) {
  if (!binding?.forkedFromThreadId) return thread;
  return { ...thread, turns: forkOwnTurns(thread, binding.forkedAtMs) };
}

export function subscriptionRestoreThread(runtimeThread, turns) {
  return {
    ...(runtimeThread ?? {}),
    turns: [...(turns ?? [])].reverse(),
  };
}

export function subscriptionRestoreNeedsFullItems(binding, thread) {
  const turns = thread?.turns ?? [];
  if (turns.some((turn) => turn.status === 'inProgress')) return true;
  const completed = [...turns].reverse().find((turn) => turn.status !== 'inProgress');
  if (!completed) return false;
  return completed.id !== binding.lastCompletedTurnId
    || (completed.status === 'completed'
      && completed.id !== binding.lastNotifiedCompletedTurnId);
}

export class CodexService extends EventEmitter {
  constructor({ config, stateStore, discoverEndpoint, logDir, spawnProcess = spawn,
    inspectDesktopOwner = inspectDesktopClientOwner, desktopFirstDirectory = null, desktopFirst = null }) {
    super();
    this.config = config;
    this.stateStore = stateStore;
    this.discoverEndpoint = discoverEndpoint;
    this.spawnProcess = spawnProcess;
    this.inspectDesktopOwner = inspectDesktopOwner;
    this.logPath = path.join(logDir, `codex-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}.jsonl`);
    this.client = null;
    this.connectingClient = null;
    this.clientGeneration = null;
    this.desktopWaitReason = null;
    this.stopping = false;
    this.connectLoopPromise = null;
    this.endpoint = null;
    this.connectionAttempt = 0;
    this.connectedAt = null;
    this.subscriptionRestoreInProgress = false;
    this.subscribedThreadIds = new Set();
    this.browserSubscriptionReleases = new Map();
    this.browserArchiveLocks = new Set();
    this.resumingThreadCounts = new Map();
    this.preparedDeliveryOwners = new WeakMap();
    const navigation = new DesktopNavigation({
      retryDelayMs: config.taskSyncIntervalMs,
      log: (event, details) => this.#log(event, details),
    });
    this.desktopFirst = desktopFirst ?? (desktopFirstDirectory && new DesktopFirst({
      directory: desktopFirstDirectory,
      runtime: () => this.#browserInitializationRuntime(),
      readThread: (id) => this.readThreadMetadata(id),
      prepareNavigation: () => navigation.prepare(this.client),
      log: (event, details) => this.#log(event, details),
    }));
    this.restoredHistoryTurnIds = new Map();
    this.subscriptionChangePollPromise = null;
    this.lastLauncherStartAt = 0;
    this.stopPromise = new Promise((resolve) => {
      this.resolveStop = resolve;
    });
  }

  get connected() {
    return Boolean(this.client?.connected);
  }

  status() {
    const bindings = typeof this.stateStore.bindingStats === 'function'
      ? this.stateStore.bindingStats()
      : (() => {
        const records = this.stateStore.bindings();
        return {
          total: records.length,
          active: records.filter((binding) => !binding.archived).length,
          archived: records.filter((binding) => binding.archived).length,
        };
      })();
    return {
      connected: this.connected,
      endpoint: this.endpoint,
      connectedAt: this.connectedAt,
      reconnectAttempt: this.connectionAttempt,
      desktopWaitReason: this.desktopWaitReason,
      bindings: bindings.total,
      activeBindings: bindings.active,
      archivedBindings: bindings.archived,
      projectCategories: this.stateStore.projectCategories().length,
    };
  }

  start() {
    if (!this.connectLoopPromise) this.connectLoopPromise = this.#connectLoop();
    return this.connectLoopPromise;
  }

  async stop() {
    this.stopping = true;
    this.resolveStop();
    this.client?.close();
    this.connectingClient?.close();
    if (!this.connectLoopPromise) return;
    let timeout;
    const completed = await Promise.race([
      this.connectLoopPromise.then(() => true).catch(() => true),
      new Promise((resolve) => {
        timeout = setTimeout(() => resolve(false), APP_SERVER_OPERATION_TIMEOUT_MS);
        timeout.unref?.();
      }),
    ]);
    if (timeout) clearTimeout(timeout);
    if (!completed) {
      this.#log('connect-loop-close-timeout', { timeoutMs: APP_SERVER_OPERATION_TIMEOUT_MS });
    }
  }

  async listThreads({ limit = this.config.taskListLimit, search = null, archived = false } = {}) {
    this.#requireClient();
    const params = { limit, archived, sortKey: 'recency_at', sortDirection: 'desc', useStateDbOnly: true };
    if (search) params.searchTerm = search;
    return this.client.call('thread/list', params, APP_SERVER_OPERATION_TIMEOUT_MS);
  }

  async listAllThreads({ archived = false, projectId = null, search = null, sourceKinds = null } = {}) {
    this.#requireClient();
    const threads = [];
    const seenCursors = new Set();
    let cursor = null;
    do {
      // Ordinary discovery reads canonical metadata, not rollout repair scans.
      const params = { limit: 100, archived, sortKey: 'updated_at', sortDirection: 'desc', useStateDbOnly: true };
      if (projectId) params.projectId = projectId;
      if (search) params.searchTerm = search;
      if (sourceKinds) params.sourceKinds = sourceKinds;
      if (cursor) params.cursor = cursor;
      const result = await this.client.call('thread/list', params, APP_SERVER_OPERATION_TIMEOUT_MS);
      threads.push(...(result.data ?? []));
      cursor = result.nextCursor ?? null;
      if (cursor && seenCursors.has(cursor)) throw new Error(`thread/list repeated cursor: ${cursor}`);
      if (cursor) seenCursors.add(cursor);
    } while (cursor);
    return threads;
  }

  async listSubagentThreads() {
    const threads = [];
    for (const archived of [false, true]) {
      threads.push(...await this.listAllThreads({ archived, sourceKinds: ['subAgent'] }));
    }
    return threads;
  }

  async listAllProjects() {
    this.#requireClient();
    return this.#collectPages('project/list', {}, 100);
  }

  async readThread(threadId) {
    this.#requireClient();
    return this.client.call('thread/read', { threadId, includeTurns: true }, APP_SERVER_OPERATION_TIMEOUT_MS);
  }

  async readThreadMetadata(threadId) {
    this.#requireClient();
    const result = await this.client.call('thread/read', { threadId, includeTurns: false });
    return result.thread;
  }

  browserInitializationGeneration() {
    return this.#browserInitializationRuntime()?.generation ?? null;
  }

  #browserInitializationRuntime() {
    if (process.platform !== 'win32' || this.stopping || !this.connected || !this.clientGeneration) return null;
    const state = readJsonIfPresent(this.config.launcherStatePath);
    if (state?.packageFamilyName !== DESKTOP_PACKAGE_FAMILY) return null;
    const compatible = state.desktopBrowserAccessCompatibility === true
      || (state.desktopBrowserAccessCompatibility === undefined && state.desktopBrowserAccessTrial === true
        && state.packageVersion === '26.1029.7803.0');
    if (!compatible) return null;
    const owner = this.#desktopOwner(this.endpoint);
    if (owner.state !== 'present' || owner.generation !== this.clientGeneration) return null;
    const local = process.env.LOCALAPPDATA;
    return {
      generation: owner.generation,
      desktopPids: state.desktopProcessIds.filter(processIsAlive),
      startedAt: state.startedAt,
      logRoots: local ? [
        path.join(local, 'Codex', 'Logs'),
        path.join(local, 'Packages', DESKTOP_PACKAGE_FAMILY, 'LocalCache', 'Local', 'Codex', 'Logs'),
      ] : [],
    };
  }

  prepareDesktopThread(threadId) {
    if (this.#requireClient()?.state === 'absent') return 'shared-server';
    return this.desktopFirst?.prepare(threadId);
  }

  reconcileDesktopThreads() {
    return this.desktopFirst?.reconcile();
  }

  async #ensureDesktopFirst(threadId) {
    if (this.browserArchiveLocks.has(threadId)) throw new DesktopThreadPendingError();
    const client = this.client;
    const state = await this.prepareDesktopThread(threadId);
    if (state === 'opening' || state === 'waiting') throw new DesktopThreadPendingError();
    if (this.client !== client) throw new Error('App Server connection closed during Desktop preparation.');
    if (this.browserArchiveLocks.has(threadId)) throw new DesktopThreadPendingError();
    const owner = this.#requireClient();
    if (state === 'shared-server' && owner?.state !== 'absent') throw new DesktopThreadPendingError();
  }

  async withBrowserArchive(threadId, operation) {
    const generation = this.browserInitializationGeneration();
    if (!generation || this.browserArchiveLocks.has(threadId) || this.isResumingThread(threadId)
      || this.desktopFirst?.isWaiting(threadId, generation)) return false;
    this.browserArchiveLocks.add(threadId);
    try { return await operation(); }
    finally { this.browserArchiveLocks.delete(threadId); }
  }

  async browserUnloadGraceMs() {
    this.#requireClient();
    const result = await this.client.call('config/read', { includeLayers: false });
    if (!result?.config) return null;
    // The installed v0.166.0-alpha.6 defaults to 60 seconds when omitted.
    const seconds = result.config.thread_unload_delay_secs ?? 60;
    const milliseconds = typeof seconds === 'number' ? seconds * 1_000 : NaN;
    return Number.isSafeInteger(milliseconds) && milliseconds >= 0 ? milliseconds : null;
  }

  async browserArchiveHasRelations(threadId) {
    this.#requireClient();
    // Do not substitute ordinary discovery: it excludes empty/attached and
    // noninteractive tasks. Check both archival states and all source kinds.
    const client = this.client;
    const related = await Promise.all(['ancestorThreadId', 'attachedToThreadId'].flatMap((relation) => (
      [false, true].map(async (archived) => {
        const seen = new Set();
        let cursor = null;
        do {
          const result = await client.call('thread/list', {
            [relation]: threadId, archived, cursor, limit: 1, sourceKinds: RELATION_SOURCE_KINDS,
            modelProviders: [], useStateDbOnly: true,
          });
          if (!Array.isArray(result?.data)) throw new Error('Missing related task inventory.');
          if (result.data.length) return true;
          cursor = result.nextCursor ?? null;
          if (cursor && seen.has(cursor)) throw new Error('Repeated related task inventory cursor.');
          if (cursor) seen.add(cursor);
        } while (cursor);
        return false;
      })
    )));
    if (this.client !== client) throw new Error('App Server connection closed during related task inventory.');
    return related.some(Boolean);
  }

  isResumingThread(threadId) {
    return this.resumingThreadCounts.has(threadId);
  }

  async releaseBrowserInitializationSubscription(threadId, generation) {
    if (this.browserInitializationGeneration() !== generation || this.isResumingThread(threadId)
      || !this.isSubscribed(threadId) || this.browserSubscriptionReleases.has(threadId)) return;
    const client = this.client;
    const request = client.call('thread/unsubscribe', { threadId });
    this.browserSubscriptionReleases.set(threadId, request);
    try {
      const { status } = await request;
      if (this.client === client && ['unsubscribed', 'notSubscribed', 'notLoaded'].includes(status)) {
        this.subscribedThreadIds.delete(threadId);
        return status;
      }
      return null;
    } finally {
      this.browserSubscriptionReleases.delete(threadId);
    }
  }

  async readRecentThread(threadId) {
    return this.readThreadWindow(threadId, { maxTurns: 2 });
  }

  async readAutomaticTranscript(threadId) {
    const preview = await this.recentTurns(threadId, { limit: 21, itemsView: 'notLoaded' });
    const maxTurns = (preview.data?.length ?? 0) > 20 || preview.nextCursor ? 1 : 5;
    return this.readThreadWindow(threadId, { maxTurns });
  }

  async readThreadWindow(threadId, { maxTurns = 5, sinceMs = null } = {}) {
    if (maxTurns !== null && (!Number.isInteger(maxTurns) || maxTurns < 1)) {
      throw new Error('maxTurns must be a positive integer or null.');
    }
    const metadata = await this.threadMetadata(threadId);
    const turns = [];
    const seenCursors = new Set();
    let cursor = null;
    let truncated = false;
    do {
      const page = await this.recentTurns(threadId, { limit: 1, itemsView: 'full', cursor });
      for (const turn of page.data ?? []) {
        const timestamp = turnTimestampMs(turn);
        if (sinceMs !== null && timestamp !== null && timestamp < sinceMs) {
          truncated = true;
          cursor = null;
          break;
        }
        turns.push(turn);
        if (maxTurns !== null && turns.length >= maxTurns) {
          truncated = Boolean(page.nextCursor);
          cursor = null;
          break;
        }
      }
      if (cursor === null && (truncated || (maxTurns !== null && turns.length >= maxTurns))) break;
      cursor = page.nextCursor ?? null;
      if (cursor && seenCursors.has(cursor)) throw new Error(`thread/turns/list repeated cursor: ${cursor}`);
      if (cursor) seenCursors.add(cursor);
    } while (cursor);
    return { thread: subscriptionRestoreThread(metadata.thread, turns), truncated };
  }

  async allTurnDescriptors(threadId) {
    const turns = [];
    const seenCursors = new Set();
    let cursor = null;
    do {
      const page = await this.recentTurns(threadId, { limit: 100, itemsView: 'notLoaded', cursor });
      turns.push(...(page.data ?? []));
      cursor = page.nextCursor ?? null;
      if (cursor && seenCursors.has(cursor)) throw new Error(`thread/turns/list repeated cursor: ${cursor}`);
      if (cursor) seenCursors.add(cursor);
    } while (cursor);
    return turns;
  }

  async readTurn(threadId, turnId) {
    if (!turnId) throw new Error('turnId is required.');
    const seenCursors = new Set();
    let cursor = null;
    do {
      const page = await this.recentTurns(threadId, { limit: 1, itemsView: 'notLoaded', cursor });
      if ((page.data ?? []).some((turn) => turn.id === turnId)) {
        const full = await this.recentTurns(threadId, { limit: 1, itemsView: 'full', cursor });
        return (full.data ?? []).find((turn) => turn.id === turnId) ?? null;
      }
      cursor = page.nextCursor ?? null;
      if (cursor && seenCursors.has(cursor)) throw new Error(`thread/turns/list repeated cursor: ${cursor}`);
      if (cursor) seenCursors.add(cursor);
    } while (cursor);
    return null;
  }

  async threadMetadata(threadId) {
    this.#requireClient();
    return this.client.call('thread/read', { threadId, includeTurns: false }, APP_SERVER_OPERATION_TIMEOUT_MS);
  }

  async hasLocalThread(threadId) {
    if (!this.connected || !threadId) return false;
    try {
      const result = await this.client.call(
        'thread/read', { threadId, includeTurns: false }, 1200,
      );
      return result.thread?.id === threadId;
    } catch {
      // Missing, disconnected and indeterminate must all fail silently before ACK.
      return false;
    }
  }

  async resumeThread(threadId, { monitorOnly = false } = {}) {
    if (this.browserArchiveLocks.has(threadId)) throw new DesktopThreadPendingError();
    this.resumingThreadCounts.set(threadId, (this.resumingThreadCounts.get(threadId) ?? 0) + 1);
    try {
      const releasing = this.browserSubscriptionReleases.get(threadId);
      if (releasing) await releasing.catch(() => {});
      this.#requireClient();
      const client = this.client;
      if (monitorOnly) {
        if (this.browserInitializationGeneration()) {
          const thread = await this.readThreadMetadata(threadId);
          if (this.client !== client || thread?.id !== threadId || thread.status?.type !== 'active') {
            throw new DesktopThreadPendingError();
          }
        }
      } else await this.#ensureDesktopFirst(threadId);
      const result = await client.call(
        'thread/resume',
        { threadId, excludeTurns: true },
        APP_SERVER_OPERATION_TIMEOUT_MS,
      );
      if (this.client === client) this.subscribedThreadIds.add(threadId);
      return result;
    } finally {
      const count = this.resumingThreadCounts.get(threadId) - 1;
      if (count) this.resumingThreadCounts.set(threadId, count);
      else this.resumingThreadCounts.delete(threadId);
    }
  }

  isSubscribed(threadId) {
    return this.subscribedThreadIds.has(threadId);
  }

  async updateThreadSettings(threadId, patch) {
    this.#requireClient();
    await this.#ensureDesktopFirst(threadId);
    await this.client.call('thread/settings/update', { threadId, ...patch }, APP_SERVER_OPERATION_TIMEOUT_MS);
    return { threadId, patch };
  }

  async listModels() {
    this.#requireClient();
    return this.#collectPages('model/list', { includeHidden: false }, 100);
  }

  async listPermissionProfiles(cwd = null) {
    this.#requireClient();
    return this.#collectPages('permissionProfile/list', cwd ? { cwd } : {}, 100);
  }

  async listCollaborationModes() {
    this.#requireClient();
    const result = await this.client.call('collaborationMode/list', {}, APP_SERVER_OPERATION_TIMEOUT_MS);
    return result.data ?? [];
  }

  async compactThread(threadId) {
    this.#requireClient();
    await this.client.call('thread/compact/start', { threadId }, APP_SERVER_OPERATION_TIMEOUT_MS);
    return { threadId };
  }

  async forkThread(threadId, lastTurnId = null) {
    this.#requireClient();
    const params = { threadId, excludeTurns: true };
    if (lastTurnId) params.lastTurnId = lastTurnId;
    return this.client.call('thread/fork', params, APP_SERVER_OPERATION_TIMEOUT_MS);
  }

  async getGoal(threadId) {
    this.#requireClient();
    return this.client.call('thread/goal/get', { threadId }, APP_SERVER_OPERATION_TIMEOUT_MS);
  }

  async setGoal(threadId, objective, tokenBudget = null) {
    this.#requireClient();
    const params = { threadId, objective };
    if (tokenBudget !== null) params.tokenBudget = tokenBudget;
    return this.client.call('thread/goal/set', params, APP_SERVER_OPERATION_TIMEOUT_MS);
  }

  async resumeGoal(threadId) {
    this.#requireClient();
    return this.client.call('thread/goal/set', { threadId, status: 'active' }, APP_SERVER_OPERATION_TIMEOUT_MS);
  }

  async clearGoal(threadId) {
    this.#requireClient();
    return this.client.call('thread/goal/clear', { threadId }, APP_SERVER_OPERATION_TIMEOUT_MS);
  }

  async startReview(threadId, target, delivery = 'inline') {
    this.#requireClient();
    await this.#ensureDesktopFirst(threadId);
    return this.client.call('review/start', { threadId, target, delivery }, APP_SERVER_OPERATION_TIMEOUT_MS);
  }

  async listBackgroundTerminals(threadId, { strict = false } = {}) {
    this.#requireClient();
    return this.#collectPages('thread/backgroundTerminals/list', { threadId }, 100, { strict });
  }

  async terminateBackgroundTerminal(threadId, processId) {
    this.#requireClient();
    return this.client.call(
      'thread/backgroundTerminals/terminate',
      { threadId, processId },
      APP_SERVER_OPERATION_TIMEOUT_MS,
    );
  }

  async setMemoryMode(threadId, mode) {
    this.#requireClient();
    if (!['enabled', 'disabled'].includes(mode)) throw new Error(`Unknown memory mode: ${mode}`);
    await this.client.call('thread/memoryMode/set', { threadId, mode }, APP_SERVER_OPERATION_TIMEOUT_MS);
    return { threadId, mode };
  }

  async accountRateLimits() {
    this.#requireClient();
    return this.client.call('account/rateLimits/read', undefined, APP_SERVER_OPERATION_TIMEOUT_MS);
  }

  async accountUsage() {
    this.#requireClient();
    return this.client.call('account/usage/read', undefined, APP_SERVER_OPERATION_TIMEOUT_MS);
  }

  async listMcpServers(threadId = null) {
    this.#requireClient();
    return this.#collectPages('mcpServerStatus/list', {
      detail: 'toolsAndAuthOnly',
      ...(threadId ? { threadId } : {}),
    }, 100);
  }

  async listSkills(cwds = []) {
    this.#requireClient();
    return this.client.call('skills/list', cwds.length ? { cwds } : {}, APP_SERVER_OPERATION_TIMEOUT_MS);
  }

  async listHooks(cwds = []) {
    this.#requireClient();
    return this.client.call('hooks/list', cwds.length ? { cwds } : {}, APP_SERVER_OPERATION_TIMEOUT_MS);
  }

  async listPlugins(cwds = []) {
    this.#requireClient();
    return this.client.call('plugin/list', cwds.length ? { cwds } : {}, APP_SERVER_OPERATION_TIMEOUT_MS);
  }

  async listExperimentalFeatures(threadId = null) {
    this.#requireClient();
    return this.#collectPages('experimentalFeature/list', threadId ? { threadId } : {}, 100);
  }

  async startThread(cwd = null) {
    this.#requireClient();
    const params = cwd ? { cwd } : {};
    const result = await this.client.call('thread/start', params, APP_SERVER_OPERATION_TIMEOUT_MS);
    if (!result.thread?.id) throw new Error('thread/start did not return a task ID.');
    return result;
  }

  async setThreadName(threadId, name) {
    this.#requireClient();
    return this.client.call('thread/name/set', { threadId, name }, APP_SERVER_OPERATION_TIMEOUT_MS);
  }

  async unsubscribeThread(threadId) {
    if (!this.connected) return null;
    return this.client.call('thread/unsubscribe', { threadId }).catch((error) => {
      this.#log('unsubscribe-failed', { threadId, error: error.message });
      return null;
    });
  }

  async archiveThread(threadId, { browserRecovery = false } = {}) {
    if (this.browserArchiveLocks.has(threadId) !== browserRecovery) throw new DesktopThreadPendingError();
    this.#requireClient();
    const result = await this.client.call('thread/archive', { threadId }, APP_SERVER_OPERATION_TIMEOUT_MS);
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Missing archive acknowledgement.');
    return { threadId };
  }

  async unarchiveThread(threadId, { browserRecovery = false } = {}) {
    if (this.browserArchiveLocks.has(threadId) !== browserRecovery) throw new DesktopThreadPendingError();
    this.#requireClient();
    return this.client.call('thread/unarchive', { threadId }, APP_SERVER_OPERATION_TIMEOUT_MS);
  }

  async activeTurn(threadId) {
    this.#requireClient();
    const result = await this.client.call('thread/turns/list', {
      threadId,
      limit: 10,
      sortDirection: 'desc',
      itemsView: 'notLoaded',
    });
    return (result.data ?? []).find((turn) => turn.status === 'inProgress') ?? null;
  }

  async recentTurns(threadId, { limit = 2, itemsView = 'full', cursor = null } = {}) {
    this.#requireClient();
    const params = {
      threadId,
      limit,
      sortDirection: 'desc',
      itemsView,
    };
    if (cursor) params.cursor = cursor;
    return this.client.call('thread/turns/list', params, APP_SERVER_OPERATION_TIMEOUT_MS);
  }

  async prepareDelivery(threadId) {
    await this.resumeThread(threadId);
    const client = this.client;
    const currentTurn = await this.activeTurn(threadId);
    if (this.client !== client) throw new Error('App Server connection closed during delivery preparation.');
    const target = currentTurn
      ? { mode: 'steer', expectedTurnId: currentTurn.id }
      : { mode: 'send', expectedTurnId: null };
    this.preparedDeliveryOwners.set(target, client);
    return target;
  }

  async executePreparedDelivery(
    threadId,
    prompt,
    attachments,
    clientUserMessageId,
    target,
  ) {
    this.#requireClient();
    if (this.browserArchiveLocks.has(threadId)) throw new DesktopThreadPendingError();
    if (!clientUserMessageId) throw new Error('Prepared delivery requires clientUserMessageId.');
    if (this.preparedDeliveryOwners.has(target) && this.preparedDeliveryOwners.get(target) !== this.client) {
      throw new Error('App Server connection closed after delivery preparation.');
    }
    if (target?.mode === 'send') {
      const result = await this.client.call('turn/start', {
        threadId,
        input: textInput(prompt, attachments),
        clientUserMessageId,
      }, APP_SERVER_OPERATION_TIMEOUT_MS);
      const turnId = result.turn?.id ?? null;
      if (!turnId) throw new Error('turn/start did not return the accepted exact turn ID.');
      return { mode: 'send', turnId, result };
    }
    if (target?.mode === 'steer' && target.expectedTurnId) {
      const result = await this.client.call('turn/steer', {
        threadId,
        expectedTurnId: target.expectedTurnId,
        input: textInput(prompt, attachments),
        clientUserMessageId,
      }, APP_SERVER_OPERATION_TIMEOUT_MS);
      return { mode: 'steer', turnId: target.expectedTurnId, result };
    }
    throw new Error(`Invalid prepared delivery target for ${threadId}.`);
  }

  async findDeliveryReceipt(threadId, clientUserMessageId, { limit = 20 } = {}) {
    const result = await this.recentTurns(threadId, { limit, itemsView: 'full' });
    for (const turn of result.data ?? []) {
      const item = (turn.items ?? []).find((candidate) => candidate.type === 'userMessage'
        && (candidate.clientId === clientUserMessageId
          || candidate.clientUserMessageId === clientUserMessageId));
      if (item) return { threadId, turnId: turn.id, itemId: item.id ?? null };
    }
    return null;
  }

  async deliver(threadId, prompt, attachments = null, clientUserMessageId = null) {
    const target = await this.prepareDelivery(threadId);
    if (clientUserMessageId) {
      return this.executePreparedDelivery(
        threadId,
        prompt,
        attachments,
        clientUserMessageId,
        target,
      );
    }
    if (target.mode === 'steer') return this.steer(threadId, prompt, attachments, null, { id: target.expectedTurnId });
    return this.send(threadId, prompt, attachments);
  }

  async send(threadId, prompt, attachments = null, clientUserMessageId = null) {
    await this.resumeThread(threadId);
    const currentTurn = await this.activeTurn(threadId);
    if (currentTurn) throw new Error(`Task already has active turn ${currentTurn.id}. Use deliver or steer.`);
    const params = {
      threadId,
      input: textInput(prompt, attachments),
    };
    if (clientUserMessageId) params.clientUserMessageId = clientUserMessageId;
    if (this.browserArchiveLocks.has(threadId)) throw new DesktopThreadPendingError();
    const result = await this.client.call('turn/start', params, APP_SERVER_OPERATION_TIMEOUT_MS);
    return { mode: 'send', turnId: result.turn?.id ?? null, result };
  }

  async steer(
    threadId,
    prompt,
    attachments = null,
    clientUserMessageId = null,
    knownTurn = null,
  ) {
    await this.resumeThread(threadId);
    const currentTurn = knownTurn ?? await this.activeTurn(threadId);
    if (!currentTurn) throw new Error('Task has no active turn to steer. Use deliver or send.');
    const params = {
      threadId,
      expectedTurnId: currentTurn.id,
      input: textInput(prompt, attachments),
    };
    if (clientUserMessageId) params.clientUserMessageId = clientUserMessageId;
    if (this.browserArchiveLocks.has(threadId)) throw new DesktopThreadPendingError();
    const result = await this.client.call('turn/steer', params);
    return { mode: 'steer', turnId: currentTurn.id, result };
  }

  async interrupt(threadId) {
    const currentTurn = await this.activeTurn(threadId);
    if (!currentTurn) throw new Error('Task has no active turn to interrupt.');
    await this.client.call('turn/interrupt', { threadId, turnId: currentTurn.id });
    return { threadId, turnId: currentTurn.id };
  }

  respondToServerRequest(requestId, result) {
    this.#requireClient();
    this.client.respond(requestId, result);
  }

  rejectServerRequest(requestId, code, message, data = undefined) {
    this.#requireClient();
    this.client.respondError(requestId, code, message, data);
  }

  async health() {
    const endpoint = this.discoverEndpoint(this.config);
    const url = new URL(endpoint.url);
    url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
    url.pathname = '/readyz';
    url.search = '';
    url.hash = '';
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(3_000) });
      return { ready: response.ok, status: response.status, endpoint: endpoint.url, source: endpoint.source };
    } catch (error) {
      return { ready: false, status: error.message, endpoint: endpoint.url, source: endpoint.source };
    }
  }

  async reconnectNow() {
    this.client?.close();
  }

  async #collectPages(method, initialParams, limit, { strict = false } = {}) {
    const data = [];
    const seenCursors = new Set();
    let cursor = null;
    do {
      const params = { ...initialParams, limit };
      if (cursor) params.cursor = cursor;
      const result = await this.client.call(method, params, APP_SERVER_OPERATION_TIMEOUT_MS);
      if (strict && !Array.isArray(result?.data)) throw new Error(`${method} omitted its inventory.`);
      data.push(...(result.data ?? []));
      cursor = result.nextCursor ?? null;
      if (cursor && seenCursors.has(cursor)) throw new Error(`${method} repeated cursor: ${cursor}`);
      if (cursor) seenCursors.add(cursor);
    } while (cursor);
    return data;
  }

  async #connectLoop() {
    while (!this.stopping) {
      let endpoint;
      try {
        endpoint = this.discoverEndpoint(this.config);
      } catch {
        this.endpoint = null;
        this.connectionAttempt += 1;
        await this.#waitForDesktop({ reason: 'invalid-shared-endpoint' });
        continue;
      }
      this.endpoint = endpoint.url;
      this.connectionAttempt += 1;
      const owner = this.#desktopOwner(endpoint.url);
      if (!sharedServerAvailable(owner)) {
        await this.#waitForDesktop(owner);
        continue;
      }
      this.emit('connectionState', { state: 'connecting', ...this.status(), source: endpoint.source });
      this.#log('connecting', { endpoint: endpoint.url, source: endpoint.source, attempt: this.connectionAttempt });
      const client = new AppServerClient(endpoint.url);
      this.connectingClient = client;
      let disconnectedResolve;
      const disconnected = new Promise((resolve) => { disconnectedResolve = resolve; });
      client.on('notification', (message) => {
        if (this.client !== client) return;
        if (!isHighVolumeCodexNotification(message)) {
          this.#log('notification', { method: message.method, threadId: message.params?.threadId, turnId: message.params?.turnId ?? message.params?.turn?.id });
        }
        this.emit('notification', message);
      });
      client.on('request', (message) => {
        if (this.client !== client) return;
        this.#log('server-request', { method: message.method, requestId: message.id, threadId: message.params?.threadId });
        this.emit('serverRequest', message);
      });
      client.on('protocolError', (error) => this.#log('protocol-error', { error: error.message }));
      client.on('socketError', (event) => this.#log('socket-error', {
        error: event?.error?.message ?? event?.message ?? 'Unknown WebSocket error.',
        code: event?.error?.code ?? null,
      }));
      client.once('disconnected', (event) => {
        this.#log('disconnected', event);
        disconnectedResolve(event);
      });

      try {
        const connected = await Promise.race([
          client.connect().then(() => true),
          this.stopPromise.then(() => false),
        ]);
        if (!connected || this.stopping) break;
        const verified = this.#desktopOwner(endpoint.url);
        if (!sharedServerAvailable(verified, owner.generation)) {
          client.close();
          this.connectingClient = null;
          await this.#waitForDesktop(sharedServerAvailable(verified)
            ? { reason: 'shared-runtime-changed-during-connect' } : verified);
          continue;
        }
        if (!client.connected) throw new Error('Shared App Server closed during initialization.');
        this.client = client;
        this.clientGeneration = verified.generation;
        this.connectingClient = null;
        this.desktopWaitReason = null;
        this.connectionAttempt = 0;
        this.connectedAt = new Date().toISOString();
        this.subscribedThreadIds.clear();
        this.restoredHistoryTurnIds.clear();
        this.subscriptionRestoreInProgress = true;
        this.emit('connectionState', { state: 'connected', ...this.status(), source: endpoint.source });
        this.#log('connected', { endpoint: endpoint.url });
        const restored = await this.#restoreSubscriptions();
        if (this.client === client && client.connected && !this.stopping) {
          this.subscriptionRestoreInProgress = false;
          this.#log('subscriptions-ready', restored);
          this.emit('subscriptionsReady', restored);
        }
        await Promise.race([disconnected, this.stopPromise]);
      } catch (error) {
        this.#log('connect-failed', { endpoint: endpoint.url, error: error.message });
        this.emit('connectionState', { state: 'disconnected', ...this.status(), error: error.message });
      } finally {
        client.close();
        if (this.client === client) this.client = null;
        if (this.connectingClient === client) this.connectingClient = null;
        this.clientGeneration = null;
        this.connectedAt = null;
        this.subscriptionRestoreInProgress = false;
        this.subscribedThreadIds.clear();
        this.restoredHistoryTurnIds.clear();
      }

      if (this.stopping) break;
      const delay = this.#connectionRetryDelay();
      this.emit('connectionState', { state: 'waiting', delayMs: delay, ...this.status() });
      await Promise.race([sleep(delay), this.stopPromise]);
    }
  }

  #desktopOwner(appServerUrl) {
    return this.inspectDesktopOwner({ launcherStatePath: this.config.launcherStatePath, appServerUrl });
  }

  #connectionRetryDelay() {
    return Math.min(30_000, 1_000 * (2 ** Math.min(this.connectionAttempt, 5)));
  }

  async #waitForDesktop({ reason }) {
    if (this.desktopWaitReason !== reason) this.#log('waiting-for-desktop', { reason });
    this.desktopWaitReason = reason;
    const delay = this.#connectionRetryDelay();
    this.emit('connectionState', { state: 'waiting', delayMs: delay, ...this.status() });
    if (reason === 'launcher-state-unavailable' || reason === 'app-server-generation-unverified') {
      this.#maybeStartSharedDesktop();
    }
    await Promise.race([sleep(delay), this.stopPromise]);
  }

  async #restoreSubscriptions() {
    const bindings = subscriptionRestoreBindings(this.stateStore.bindings())
      .filter((binding) => !this.isSubscribed(binding.threadId));
    // A reconnect must not hydrate several unbounded histories on one
    // WebSocket. Check recent metadata first and subscribe only to active work.
    // A missed completion can be recovered from stored history without loading
    // the task ahead of Desktop and its per-task tool configuration.
    const outcome = {
      total: bindings.length,
      restored: 0,
      skipped: 0,
      failed: 0,
    };
    await forEachConcurrent(bindings, 1, async (binding) => {
      try {
        const summaryResult = await this.recentTurns(binding.threadId, {
          limit: 2,
          itemsView: 'notLoaded',
        });
        const summaryThread = threadForSubscriptionRestore(
          binding,
          subscriptionRestoreThread({
            id: binding.threadId,
            name: binding.name ?? null,
            cwd: binding.cwd ?? null,
            path: binding.sessionPath ?? null,
            status: {
              type: (summaryResult.data ?? []).some((turn) => turn.status === 'inProgress')
                ? 'active'
                : 'idle',
            },
          }, summaryResult.data),
        );
        const wasActive = summaryThread.turns.some((turn) => turn.status === 'inProgress');
        const summaryCompleted = summaryThread.turns.at(-1);
        if (!subscriptionRestoreNeedsFullItems(binding, summaryThread) ||
          (!wasActive && summaryCompleted?.id === this.restoredHistoryTurnIds.get(binding.threadId))) {
          outcome.skipped += 1;
          return;
        }
        let runtime = wasActive ? await this.resumeThread(binding.threadId, { monitorOnly: true }) : null;
        let hydratedResult = await this.recentTurns(binding.threadId);
        let thread = threadForSubscriptionRestore(
          binding,
          subscriptionRestoreThread(runtime?.thread ?? summaryThread, hydratedResult.data),
        );
        if (!runtime && thread.turns.some((turn) => turn.status === 'inProgress')) {
          // A turn may have started between the summary and history reads.
          runtime = await this.resumeThread(binding.threadId, { monitorOnly: true });
          hydratedResult = await this.recentTurns(binding.threadId);
          thread = threadForSubscriptionRestore(
            binding, subscriptionRestoreThread(runtime.thread, hydratedResult.data),
          );
        }
        const completed = [...(thread.turns ?? [])].reverse()
          .find((turn) => turn.status !== 'inProgress');
        if (!runtime && completed?.id) {
          // Keep the same one-attempt-per-connection behavior as a subscription
          // while the controller settles the completion and persists its receipt.
          if (this.restoredHistoryTurnIds.get(binding.threadId) === completed.id) {
            outcome.skipped += 1;
            return;
          }
          this.restoredHistoryTurnIds.set(binding.threadId, completed.id);
        }
        const finalText = finalTextFromTurn(completed, needsSessionCompletionFallback(completed)
          ? completionTextFromSession(thread.path, completed?.id)
          : '');
        const needsCompletionMessage = completed?.id !== binding.lastCompletedTurnId;
        const needsCompletionNotice = completed?.status === 'completed'
          && completed.id !== binding.lastNotifiedCompletedTurnId;
        this.emit('subscriptionRestored', {
          binding,
          thread,
          runtime,
          missedCompletion: completed && (needsCompletionMessage || needsCompletionNotice)
            ? { turn: completed, finalText, needsCompletionMessage, needsCompletionNotice }
            : null,
        });
        this.#log('subscription-restored', {
          threadId: binding.threadId,
          status: threadStatusLabel(thread.status),
          subscribed: Boolean(runtime),
          missedTurnId: needsCompletionMessage || needsCompletionNotice ? completed?.id : null,
        });
        outcome.restored += 1;
      } catch (error) {
        if (error instanceof DesktopThreadPendingError) {
          outcome.skipped += 1;
          return;
        }
        outcome.failed += 1;
        this.#log('subscription-restore-failed', { threadId: binding.threadId, error: error.message });
        this.emit('subscriptionError', { binding, error });
      }
    });
    return outcome;
  }

  restoreChangedSubscriptions() {
    if (this.stopping || !this.connected || this.subscriptionRestoreInProgress) {
      return Promise.resolve(null);
    }
    if (this.subscriptionChangePollPromise) return this.subscriptionChangePollPromise;
    const poll = this.#restoreSubscriptions()
      .finally(() => {
        if (this.subscriptionChangePollPromise === poll) {
          this.subscriptionChangePollPromise = null;
        }
      });
    this.subscriptionChangePollPromise = poll;
    return poll;
  }

  #requireClient() {
    if (!this.client?.connected) throw new Error('Codex app-server is offline. The bridge will retry automatically.');
    if (this.clientGeneration !== null) {
      const owner = this.#desktopOwner(this.endpoint);
      if (!sharedServerAvailable(owner, this.clientGeneration)) {
        throw new Error('Shared App Server ownership is unverified. The bridge will retry automatically.');
      }
      return owner;
    }
  }

  #maybeStartSharedDesktop() {
    if (!this.config.autoStartSharedDesktop) return;
    // The interactive logon host owns startup and exposes explicit per-step retries.
    if (process.env.CODEX_SHARED_STARTUP_MANAGED === '1') return;
    const launcherPath = this.config.sharedLauncherPath;
    if (!launcherPath || !fs.existsSync(launcherPath)) {
      this.#log('shared-launcher-missing', { launcherPath });
      return;
    }
    // A direct Bridge start gets at most one initial launch, never a launch loop.
    if (this.lastLauncherStartAt > 0) return;
    this.lastLauncherStartAt = Date.now();
    try {
      const child = this.spawnProcess(launcherPath, ['--no-dialogs'], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.unref();
      this.#log('shared-launcher-started', { launcherPath, pid: child.pid });
      this.emit('launcherStarted', { launcherPath, pid: child.pid });
    } catch (error) {
      this.#log('shared-launcher-start-failed', { launcherPath, error: error.message });
    }
  }

  #log(event, details) {
    appendJsonLine(this.logPath, event, details);
  }
}
