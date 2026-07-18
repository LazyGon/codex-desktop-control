import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { AppServerClient } from './app-server-client.mjs';
import {
  appendJsonLine,
  completionTextFromSession,
  finalTextFromTurn,
  sleep,
  threadStatusLabel,
} from './util.mjs';

function textInput(text, attachment = null) {
  const input = [{ type: 'text', text }];
  if (attachment?.kind === 'image') input.push({ type: 'image', url: attachment.url });
  if (attachment?.kind === 'text') {
    input[0].text += `\n\nAttached file: ${attachment.name}\n\n${attachment.text}`;
  }
  return input;
}

export class CodexService extends EventEmitter {
  constructor({ config, stateStore, discoverEndpoint, logDir }) {
    super();
    this.config = config;
    this.stateStore = stateStore;
    this.discoverEndpoint = discoverEndpoint;
    this.logPath = path.join(logDir, `codex-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}.jsonl`);
    this.client = null;
    this.stopping = false;
    this.connectLoopPromise = null;
    this.endpoint = null;
    this.connectionAttempt = 0;
    this.connectedAt = null;
    this.lastLauncherStartAt = 0;
  }

  get connected() {
    return Boolean(this.client?.connected);
  }

  status() {
    const bindings = this.stateStore.bindings();
    return {
      connected: this.connected,
      endpoint: this.endpoint,
      connectedAt: this.connectedAt,
      reconnectAttempt: this.connectionAttempt,
      bindings: bindings.length,
      activeBindings: bindings.filter((binding) => !binding.archived).length,
      archivedBindings: bindings.filter((binding) => binding.archived).length,
      projectCategories: this.stateStore.projectCategories().length,
    };
  }

  start() {
    if (!this.connectLoopPromise) this.connectLoopPromise = this.#connectLoop();
    return this.connectLoopPromise;
  }

  async stop() {
    this.stopping = true;
    this.client?.close();
    if (!this.connectLoopPromise) return;
    const completed = await Promise.race([
      this.connectLoopPromise.then(() => true).catch(() => true),
      sleep(3_000).then(() => false),
    ]);
    if (!completed) this.#log('connect-loop-close-timeout', { timeoutMs: 3_000 });
  }

  async listThreads({ limit = this.config.taskListLimit, search = null, archived = false } = {}) {
    this.#requireClient();
    const params = { limit, archived, sortKey: 'recency_at', sortDirection: 'desc' };
    if (search) params.searchTerm = search;
    return this.client.call('thread/list', params, 60_000);
  }

  async listAllThreads({ archived = false } = {}) {
    this.#requireClient();
    const threads = [];
    const seenCursors = new Set();
    let cursor = null;
    do {
      const params = { limit: 100, archived, sortKey: 'recency_at', sortDirection: 'desc' };
      if (cursor) params.cursor = cursor;
      const result = await this.client.call('thread/list', params, 60_000);
      threads.push(...(result.data ?? []));
      cursor = result.nextCursor ?? null;
      if (cursor && seenCursors.has(cursor)) throw new Error(`thread/list repeated cursor: ${cursor}`);
      if (cursor) seenCursors.add(cursor);
    } while (cursor);
    return threads;
  }

  async readThread(threadId) {
    this.#requireClient();
    return this.client.call('thread/read', { threadId, includeTurns: true }, 60_000);
  }

  async threadMetadata(threadId) {
    this.#requireClient();
    return this.client.call('thread/read', { threadId, includeTurns: false }, 30_000);
  }

  async resumeThread(threadId) {
    this.#requireClient();
    return this.client.call('thread/resume', { threadId, excludeTurns: true }, 60_000);
  }

  async startThread(cwd = null) {
    this.#requireClient();
    const params = cwd ? { cwd } : {};
    const result = await this.client.call('thread/start', params, 60_000);
    if (!result.thread?.id) throw new Error('thread/start did not return a task ID.');
    return result;
  }

  async setThreadName(threadId, name) {
    this.#requireClient();
    return this.client.call('thread/name/set', { threadId, name }, 30_000);
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
    await this.client.call('thread/archive', { threadId }, 60_000);
    return { threadId };
  }

  async unarchiveThread(threadId) {
    this.#requireClient();
    return this.client.call('thread/unarchive', { threadId }, 60_000);
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

  async deliver(threadId, prompt, attachment = null) {
    await this.resumeThread(threadId);
    const currentTurn = await this.activeTurn(threadId);
    if (currentTurn) return this.steer(threadId, prompt, attachment, currentTurn);
    return this.send(threadId, prompt, attachment);
  }

  async send(threadId, prompt, attachment = null) {
    await this.resumeThread(threadId);
    const currentTurn = await this.activeTurn(threadId);
    if (currentTurn) throw new Error(`Task already has active turn ${currentTurn.id}. Use deliver or steer.`);
    const result = await this.client.call('turn/start', {
      threadId,
      input: textInput(prompt, attachment),
    }, 60_000);
    return { mode: 'send', turnId: result.turn?.id ?? null, result };
  }

  async steer(threadId, prompt, attachment = null, knownTurn = null) {
    await this.resumeThread(threadId);
    const currentTurn = knownTurn ?? await this.activeTurn(threadId);
    if (!currentTurn) throw new Error('Task has no active turn to steer. Use deliver or send.');
    if (attachment) throw new Error('Attachments cannot be added with steer. Use deliver on an idle task.');
    const result = await this.client.call('turn/steer', {
      threadId,
      expectedTurnId: currentTurn.id,
      input: textInput(prompt),
    });
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
        this.#log('notification', { method: message.method, threadId: message.params?.threadId, turnId: message.params?.turnId ?? message.params?.turn?.id });
        this.emit('notification', message);
      });
      client.on('request', (message) => {
        this.#log('server-request', { method: message.method, requestId: message.id, threadId: message.params?.threadId });
        this.emit('serverRequest', message);
      });
      client.on('protocolError', (error) => this.#log('protocol-error', { error: error.message }));
      client.on('socketError', () => {});
      client.once('disconnected', disconnectedResolve);

      try {
        await client.connect();
        this.connectionAttempt = 0;
        this.connectedAt = new Date().toISOString();
        this.emit('connectionState', { state: 'connected', ...this.status(), source: endpoint.source });
        this.#log('connected', { endpoint: endpoint.url });
        await this.#restoreSubscriptions();
        await disconnected;
      } catch (error) {
        this.#log('connect-failed', { endpoint: endpoint.url, error: error.message });
        this.emit('connectionState', { state: 'disconnected', ...this.status(), error: error.message });
        this.#maybeStartSharedDesktop();
      } finally {
        client.close();
        if (this.client === client) this.client = null;
        this.connectedAt = null;
      }

      if (this.stopping) break;
      const delay = Math.min(30_000, 1_000 * (2 ** Math.min(this.connectionAttempt, 5)));
      this.emit('connectionState', { state: 'waiting', delayMs: delay, ...this.status() });
      await sleep(delay);
    }
  }

  async #restoreSubscriptions() {
    for (const binding of this.stateStore.bindings()) {
      if (binding.archived) continue;
      try {
        await this.resumeThread(binding.threadId);
        const result = await this.readThread(binding.threadId);
        const thread = result.thread;
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
          missedCompletion: completed && (needsCompletionMessage || needsCompletionNotice)
            ? { turn: completed, finalText, needsCompletionMessage, needsCompletionNotice }
            : null,
        });
        this.#log('subscription-restored', {
          threadId: binding.threadId,
          status: threadStatusLabel(thread.status),
          missedTurnId: needsCompletionMessage || needsCompletionNotice ? completed?.id : null,
        });
      } catch (error) {
        this.#log('subscription-restore-failed', { threadId: binding.threadId, error: error.message });
        this.emit('subscriptionError', { binding, error });
      }
    }
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
      const child = spawn(launcherPath, [], {
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
