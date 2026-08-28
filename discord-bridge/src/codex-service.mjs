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
  sleep,
  threadStatusLabel,
} from './util.mjs';
import { isHighVolumeCodexNotification } from './codex-notification-buffer.mjs';
import { forkOwnTurns } from './session-fork-info.mjs';

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

export class CodexService extends EventEmitter {
  constructor({ config, stateStore, discoverEndpoint, logDir, spawnProcess = spawn }) {
    super();
    this.config = config;
    this.stateStore = stateStore;
    this.discoverEndpoint = discoverEndpoint;
    this.spawnProcess = spawnProcess;
    this.logPath = path.join(logDir, `codex-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}.jsonl`);
    this.client = null;
    this.stopping = false;
    this.connectLoopPromise = null;
    this.endpoint = null;
    this.connectionAttempt = 0;
    this.connectedAt = null;
    this.subscriptionRestoreInProgress = false;
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
    const params = { limit, archived, sortKey: 'recency_at', sortDirection: 'desc' };
    if (search) params.searchTerm = search;
    return this.client.call('thread/list', params, APP_SERVER_OPERATION_TIMEOUT_MS);
  }

  async listAllThreads({ archived = false, projectId = null } = {}) {
    this.#requireClient();
    const threads = [];
    const seenCursors = new Set();
    let cursor = null;
    do {
      const params = { limit: 100, archived, sortKey: 'recency_at', sortDirection: 'desc' };
      if (projectId) params.projectId = projectId;
      if (cursor) params.cursor = cursor;
      const result = await this.client.call('thread/list', params, APP_SERVER_OPERATION_TIMEOUT_MS);
      threads.push(...(result.data ?? []));
      cursor = result.nextCursor ?? null;
      if (cursor && seenCursors.has(cursor)) throw new Error(`thread/list repeated cursor: ${cursor}`);
      if (cursor) seenCursors.add(cursor);
    } while (cursor);
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

  async threadMetadata(threadId) {
    this.#requireClient();
    return this.client.call('thread/read', { threadId, includeTurns: false }, APP_SERVER_OPERATION_TIMEOUT_MS);
  }

  async resumeThread(threadId) {
    this.#requireClient();
    return this.client.call('thread/resume', { threadId, excludeTurns: true }, APP_SERVER_OPERATION_TIMEOUT_MS);
  }

  async updateThreadSettings(threadId, patch) {
    this.#requireClient();
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

  async clearGoal(threadId) {
    this.#requireClient();
    return this.client.call('thread/goal/clear', { threadId }, APP_SERVER_OPERATION_TIMEOUT_MS);
  }

  async startReview(threadId, target, delivery = 'inline') {
    this.#requireClient();
    return this.client.call('review/start', { threadId, target, delivery }, APP_SERVER_OPERATION_TIMEOUT_MS);
  }

  async listBackgroundTerminals(threadId) {
    this.#requireClient();
    return this.#collectPages('thread/backgroundTerminals/list', { threadId }, 100);
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

  async archiveThread(threadId) {
    this.#requireClient();
    await this.client.call('thread/archive', { threadId }, APP_SERVER_OPERATION_TIMEOUT_MS);
    return { threadId };
  }

  async unarchiveThread(threadId) {
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

  async recentTurns(threadId, { limit = 2, itemsView = 'full' } = {}) {
    this.#requireClient();
    return this.client.call('thread/turns/list', {
      threadId,
      limit,
      sortDirection: 'desc',
      itemsView,
    }, APP_SERVER_OPERATION_TIMEOUT_MS);
  }

  async prepareDelivery(threadId) {
    await this.resumeThread(threadId);
    const currentTurn = await this.activeTurn(threadId);
    return currentTurn
      ? { mode: 'steer', expectedTurnId: currentTurn.id }
      : { mode: 'send', expectedTurnId: null };
  }

  async executePreparedDelivery(
    threadId,
    prompt,
    attachments,
    clientUserMessageId,
    target,
  ) {
    this.#requireClient();
    if (!clientUserMessageId) throw new Error('Prepared delivery requires clientUserMessageId.');
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
    const result = await this.client.call('turn/steer', params);
    return { mode: 'steer', turnId: currentTurn.id, result };
  }

  async interrupt(threadId) {
    await this.resumeThread(threadId);
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

  async #collectPages(method, initialParams, limit) {
    const data = [];
    const seenCursors = new Set();
    let cursor = null;
    do {
      const params = { ...initialParams, limit };
      if (cursor) params.cursor = cursor;
      const result = await this.client.call(method, params, APP_SERVER_OPERATION_TIMEOUT_MS);
      data.push(...(result.data ?? []));
      cursor = result.nextCursor ?? null;
      if (cursor && seenCursors.has(cursor)) throw new Error(`${method} repeated cursor: ${cursor}`);
      if (cursor) seenCursors.add(cursor);
    } while (cursor);
    return data;
  }

  async #connectLoop() {
    while (!this.stopping) {
      const endpoint = this.discoverEndpoint(this.config);
      this.endpoint = endpoint.url;
      this.connectionAttempt += 1;
      this.emit('connectionState', { state: 'connecting', ...this.status(), source: endpoint.source });
      this.#log('connecting', { endpoint: endpoint.url, source: endpoint.source, attempt: this.connectionAttempt });
      const client = new AppServerClient(endpoint.url);
      this.client = client;
      let disconnectedResolve;
      const disconnected = new Promise((resolve) => { disconnectedResolve = resolve; });
      client.on('notification', (message) => {
        if (!isHighVolumeCodexNotification(message)) {
          this.#log('notification', { method: message.method, threadId: message.params?.threadId, turnId: message.params?.turnId ?? message.params?.turn?.id });
        }
        this.emit('notification', message);
      });
      client.on('request', (message) => {
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
        if (!connected) break;
        this.connectionAttempt = 0;
        this.connectedAt = new Date().toISOString();
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
        this.#maybeStartSharedDesktop();
      } finally {
        client.close();
        if (this.client === client) this.client = null;
        this.connectedAt = null;
        this.subscriptionRestoreInProgress = false;
      }

      if (this.stopping) break;
      const delay = Math.min(30_000, 1_000 * (2 ** Math.min(this.connectionAttempt, 5)));
      this.emit('connectionState', { state: 'waiting', delayMs: delay, ...this.status() });
      await Promise.race([sleep(delay), this.stopPromise]);
    }
  }

  async #restoreSubscriptions() {
    const bindings = subscriptionRestoreBindings(this.stateStore.bindings());
    // A reconnect must not hydrate several unbounded histories on one
    // WebSocket. Newer app-server builds can close that overloaded connection,
    // causing every restore to restart from the beginning. Resume one task at
    // a time and request only the bounded recent turns needed for live-card and
    // missed-completion reconciliation.
    const outcome = { total: bindings.length, restored: 0, failed: 0 };
    await forEachConcurrent(bindings, 1, async (binding) => {
      try {
        const runtime = await this.resumeThread(binding.threadId);
        const result = await this.recentTurns(binding.threadId);
        const thread = threadForSubscriptionRestore(
          binding,
          subscriptionRestoreThread(runtime.thread, result.data),
        );
        const completed = [...(thread.turns ?? [])].reverse().find((turn) => turn.status !== 'inProgress');
        const finalText = finalTextFromTurn(
          completed,
          completionTextFromSession(thread.path, completed?.id),
        );
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
          missedTurnId: needsCompletionMessage || needsCompletionNotice ? completed?.id : null,
        });
        outcome.restored += 1;
      } catch (error) {
        outcome.failed += 1;
        this.#log('subscription-restore-failed', { threadId: binding.threadId, error: error.message });
        this.emit('subscriptionError', { binding, error });
      }
    });
    return outcome;
  }

  #requireClient() {
    if (!this.client?.connected) throw new Error('Codex app-server is offline. The bridge will retry automatically.');
  }

  #maybeStartSharedDesktop() {
    if (!this.config.autoStartSharedDesktop) return;
    const launcherPath = this.config.sharedLauncherPath;
    if (!launcherPath || !fs.existsSync(launcherPath)) {
      this.#log('shared-launcher-missing', { launcherPath });
      return;
    }
    if (Date.now() - this.lastLauncherStartAt < 120_000) return;
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
