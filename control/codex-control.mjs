import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const controlDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.dirname(controlDir);
const stateDir = path.join(rootDir, 'state');
const logDir = path.join(rootDir, 'logs');
fs.mkdirSync(stateDir, { recursive: true });
fs.mkdirSync(logDir, { recursive: true });

const stateCandidates = [
  path.join(rootDir, 'launcher', 'state', 'current.json'),
];

function nowIso() {
  return new Date().toISOString();
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function parseArguments(values) {
  const positionals = [];
  const options = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith('--')) {
      positionals.push(value);
      continue;
    }

    const equalsIndex = value.indexOf('=');
    if (equalsIndex > 2) {
      options[value.slice(2, equalsIndex)] = value.slice(equalsIndex + 1);
      continue;
    }

    const name = value.slice(2);
    const next = values[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      options[name] = next;
      index += 1;
    } else {
      options[name] = true;
    }
  }
  return { positionals, options };
}

function positiveInteger(value, fallback, name) {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

function readJsonIfPresent(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

function discoverEndpoint(explicitUrl) {
  if (explicitUrl) return { url: explicitUrl, source: '--url', runtimeState: null };
  if (process.env.CODEX_APP_SERVER_WS_URL) {
    return {
      url: process.env.CODEX_APP_SERVER_WS_URL,
      source: 'process environment',
      runtimeState: null,
    };
  }

  for (const candidate of stateCandidates) {
    const state = readJsonIfPresent(candidate);
    if (state?.websocketUrl) {
      return { url: state.websocketUrl, source: candidate, runtimeState: state };
    }
  }

  return { url: 'ws://127.0.0.1:8798', source: 'default', runtimeState: null };
}

function readyUrl(websocketUrl) {
  const url = new URL(websocketUrl);
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  url.pathname = '/readyz';
  url.search = '';
  url.hash = '';
  return url.toString();
}

function atomicWriteJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temporaryPath, filePath);
}

function appendLog(filePath, message, details = null) {
  const suffix = details === null ? '' : ` ${JSON.stringify(details)}`;
  fs.appendFileSync(filePath, `${nowIso()} ${message}${suffix}\n`, 'utf8');
}

class AppServerClient {
  constructor(url, logPath) {
    this.url = url;
    this.logPath = logPath;
    this.socket = null;
    this.nextId = 1;
    this.pending = new Map();
    this.waiters = new Set();
    this.recentNotifications = [];
  }

  async connect() {
    this.socket = new WebSocket(this.url);
    this.socket.addEventListener('message', (event) => this.#handleMessage(event));
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`WebSocket open timed out: ${this.url}`)), 10_000);
      this.socket.addEventListener('open', () => {
        clearTimeout(timeout);
        resolve();
      }, { once: true });
      this.socket.addEventListener('error', () => {
        clearTimeout(timeout);
        reject(new Error(`Unable to connect to ${this.url}`));
      }, { once: true });
    });

    await this.call('initialize', {
      clientInfo: { name: 'codex-desktop-control', version: '1.0.0' },
      capabilities: { experimentalApi: true },
    });
  }

  #handleMessage(event) {
    let message;
    try {
      message = JSON.parse(String(event.data));
    } catch (error) {
      appendLog(this.logPath, 'invalid-json', { error: error.message });
      return;
    }

    if (Object.hasOwn(message, 'id') && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(pending.timeout);
      if (message.error) pending.reject(new Error(`${pending.method}: ${JSON.stringify(message.error)}`));
      else pending.resolve(message.result);
      return;
    }

    if (!message.method) return;
    const notification = { receivedAt: Date.now(), ...message };
    this.recentNotifications.push(notification);
    if (this.recentNotifications.length > 500) this.recentNotifications.shift();
    for (const waiter of [...this.waiters]) {
      if (waiter.predicate(notification)) {
        this.waiters.delete(waiter);
        clearTimeout(waiter.timeout);
        waiter.resolve(notification);
      }
    }
  }

  call(method, params, timeoutMilliseconds = 30_000) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('WebSocket is not open.'));
    }
    const id = this.nextId;
    this.nextId += 1;
    const request = { jsonrpc: '2.0', id, method, params };
    appendLog(this.logPath, 'rpc-send', { id, method });
    this.socket.send(JSON.stringify(request));
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMilliseconds} ms.`));
      }, timeoutMilliseconds);
      this.pending.set(id, { method, resolve, reject, timeout });
    });
  }

  waitFor(predicate, timeoutMilliseconds, notBefore = 0) {
    const existing = this.recentNotifications.find(
      (notification) => notification.receivedAt >= notBefore && predicate(notification),
    );
    if (existing) return Promise.resolve(existing);

    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, reject, timeout: null };
      waiter.timeout = setTimeout(() => {
        this.waiters.delete(waiter);
        reject(new Error(`Notification wait timed out after ${timeoutMilliseconds} ms.`));
      }, timeoutMilliseconds);
      this.waiters.add(waiter);
    });
  }

  close() {
    try {
      this.socket?.close();
    } catch {
      // The process is exiting; no recovery is required here.
    }
  }
}

function notificationFor(method, threadId, turnId = null) {
  return (message) => {
    if (message.method !== method || message.params?.threadId !== threadId) return false;
    if (turnId === null) return true;
    return message.params?.turn?.id === turnId;
  };
}

function userInput(text) {
  return [{ type: 'text', text }];
}

async function listThreads(client, options, overrides = {}) {
  const limit = positiveInteger(overrides.limit ?? options.limit, 20, '--limit');
  const params = {
    limit,
    sortKey: 'recency_at',
    sortDirection: 'desc',
  };
  const searchTerm = overrides.searchTerm ?? options.search;
  if (searchTerm) params.searchTerm = String(searchTerm);
  if (options.cwd) params.cwd = String(options.cwd);
  return client.call('thread/list', params);
}

async function resolveThread(client, selector, options) {
  if (options.search) {
    const result = await listThreads(client, options, { limit: 20, searchTerm: options.search });
    if (result.data.length === 0) throw new Error(`No task matched: ${options.search}`);
    if (result.data.length > 1 && !options.latest) {
      throw new Error(`Multiple tasks matched '${options.search}'. Use an exact thread id or --latest.`);
    }
    return result.data[0];
  }

  if (selector && selector !== 'latest') {
    const result = await client.call('thread/read', { threadId: selector, includeTurns: false });
    return result.thread;
  }

  const result = await listThreads(client, options, { limit: 1 });
  if (result.data.length === 0) throw new Error('No task was found.');
  return result.data[0];
}

function itemText(item) {
  if (item.type === 'agentMessage') return item.text ?? '';
  if (item.type === 'userMessage') {
    return (item.content ?? []).map((content) => content.text ?? '').filter(Boolean).join('\n');
  }
  return '';
}

function summarizeThread(thread, messageLimit, characterLimit) {
  const messages = [];
  for (const turn of thread.turns ?? []) {
    for (const item of turn.items ?? []) {
      if (item.type !== 'userMessage' && item.type !== 'agentMessage') continue;
      const fullText = itemText(item);
      const text = fullText.length > characterLimit
        ? `${fullText.slice(0, characterLimit)}\n...[truncated ${fullText.length - characterLimit} chars]`
        : fullText;
      messages.push({
        turnId: turn.id,
        turnStatus: turn.status,
        role: item.type === 'userMessage' ? 'user' : 'assistant',
        phase: item.phase ?? null,
        text,
      });
    }
  }
  return {
    id: thread.id,
    name: thread.name ?? null,
    preview: thread.preview ?? null,
    status: thread.status,
    cwd: thread.cwd,
    updatedAt: thread.updatedAt,
    messages: messages.slice(-messageLimit),
  };
}

async function resumeThread(client, threadId) {
  return client.call('thread/resume', { threadId, excludeTurns: true });
}

async function activeTurn(client, threadId) {
  const result = await client.call('thread/turns/list', {
    threadId,
    limit: 10,
    sortDirection: 'desc',
    itemsView: 'notLoaded',
  });
  return (result.data ?? []).find((turn) => turn.status === 'inProgress') ?? null;
}

function readMessage(options, remainingPositionals) {
  if (options['message-file']) {
    return fs.readFileSync(path.resolve(String(options['message-file'])), 'utf8');
  }
  if (typeof options.message === 'string') return options.message;
  if (remainingPositionals.length > 0) return remainingPositionals.join(' ');
  throw new Error('A message is required. Use --message or --message-file.');
}

function beep(kind) {
  const command = kind === 'started'
    ? '[console]::beep(880,180); Start-Sleep -Milliseconds 90; [console]::beep(1175,220)'
    : '[console]::beep(1175,180); Start-Sleep -Milliseconds 90; [console]::beep(880,180)';
  const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
    windowsHide: true,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}

function print(value, compact = false) {
  process.stdout.write(`${JSON.stringify(value, null, compact ? 0 : 2)}\n`);
}

function usage() {
  return `codex-control commands:
  status
  list [--limit N] [--search TEXT] [--cwd PATH]
  catchup <thread-id|latest> [--messages N] [--chars N]
  send <thread-id|latest> --message TEXT [--wait]
  steer <thread-id|latest> --message TEXT
  deliver <thread-id|latest> --message TEXT [--wait]
  interrupt <thread-id|latest>
  watch [--seconds N]
  wake-after-turn <thread-id> --message TEXT [--marker ID] [--delay-ms N]

Global options: --url ws://127.0.0.1:8798, --compact`;
}

async function main() {
  const { positionals, options } = parseArguments(process.argv.slice(2));
  const command = positionals[0] ?? 'help';
  if (command === 'help' || options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const endpoint = discoverEndpoint(options.url);
  const runLog = path.join(logDir, `control-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}.log`);
  appendLog(runLog, 'command-start', { pid: process.pid, command, endpoint: endpoint.url, source: endpoint.source });

  if (command === 'status') {
    let ready = false;
    let readyStatus = null;
    try {
      const response = await fetch(readyUrl(endpoint.url), { signal: AbortSignal.timeout(3_000) });
      ready = response.ok;
      readyStatus = response.status;
    } catch (error) {
      readyStatus = error.message;
    }
    print({
      endpoint: endpoint.url,
      endpointSource: endpoint.source,
      ready,
      readyStatus,
      runtimeState: endpoint.runtimeState,
    }, options.compact === true);
    if (!ready) process.exitCode = 1;
    return;
  }

  const client = new AppServerClient(endpoint.url, runLog);
  await client.connect();
  try {
    if (command === 'list') {
      const result = await listThreads(client, options);
      print({
        endpoint: endpoint.url,
        tasks: result.data.map((thread) => ({
          id: thread.id,
          name: thread.name ?? null,
          preview: thread.preview,
          status: thread.status,
          cwd: thread.cwd,
          source: thread.source,
          recencyAt: thread.recencyAt,
          updatedAt: thread.updatedAt,
        })),
        nextCursor: result.nextCursor ?? null,
      }, options.compact === true);
      return;
    }

    if (command === 'catchup' || command === 'read') {
      const metadata = await resolveThread(client, positionals[1], options);
      const result = await client.call('thread/read', { threadId: metadata.id, includeTurns: true }, 60_000);
      const messageLimit = positiveInteger(options.messages, command === 'catchup' ? 16 : 30, '--messages');
      const characterLimit = positiveInteger(options.chars, 6_000, '--chars');
      print(summarizeThread(result.thread, messageLimit, characterLimit), options.compact === true);
      return;
    }

    if (command === 'send' || command === 'steer' || command === 'deliver') {
      const metadata = await resolveThread(client, positionals[1], options);
      const message = readMessage(options, positionals.slice(2));
      await resumeThread(client, metadata.id);
      const currentTurn = await activeTurn(client, metadata.id);
      let mode = command;
      if (command === 'deliver') mode = currentTurn ? 'steer' : 'send';

      const requestedAt = Date.now();
      let result;
      let turnId;
      if (mode === 'steer') {
        if (!currentTurn) throw new Error('The task has no active turn to steer.');
        result = await client.call('turn/steer', {
          threadId: metadata.id,
          expectedTurnId: currentTurn.id,
          input: userInput(message),
        });
        turnId = currentTurn.id;
      } else {
        if (currentTurn) throw new Error(`The task already has active turn ${currentTurn.id}. Use steer or deliver.`);
        result = await client.call('turn/start', { threadId: metadata.id, input: userInput(message) });
        turnId = result.turn?.id ?? null;
      }

      if (options.wait === true && turnId) {
        await client.waitFor(notificationFor('turn/completed', metadata.id, turnId), 30 * 60_000, requestedAt);
      }
      print({ accepted: true, mode, threadId: metadata.id, turnId, result }, options.compact === true);
      return;
    }

    if (command === 'interrupt') {
      const metadata = await resolveThread(client, positionals[1], options);
      await resumeThread(client, metadata.id);
      const currentTurn = await activeTurn(client, metadata.id);
      if (!currentTurn) throw new Error('The task has no active turn to interrupt.');
      const result = await client.call('turn/interrupt', { threadId: metadata.id, turnId: currentTurn.id });
      print({ interrupted: true, threadId: metadata.id, turnId: currentTurn.id, result }, options.compact === true);
      return;
    }

    if (command === 'watch') {
      const seconds = positiveInteger(options.seconds, 300, '--seconds');
      const startedAt = Date.now();
      print({ watching: true, endpoint: endpoint.url, seconds }, true);
      while (Date.now() - startedAt < seconds * 1_000) {
        const notification = await client.waitFor(
          (message) => ['thread/started', 'thread/status/changed', 'turn/started', 'turn/completed'].includes(message.method),
          Math.min(30_000, seconds * 1_000),
          Date.now(),
        ).catch(() => null);
        if (notification) print(notification, true);
      }
      return;
    }

    if (command === 'wake-after-turn') {
      const metadata = await resolveThread(client, positionals[1], options);
      const message = readMessage(options, positionals.slice(2));
      const marker = String(options.marker ?? `ui-wake-${Date.now()}`);
      const delayMilliseconds = positiveInteger(options['delay-ms'], 2_000, '--delay-ms');
      const timeoutMilliseconds = positiveInteger(options['timeout-ms'], 30 * 60_000, '--timeout-ms');
      const retries = positiveInteger(options.retries, 5, '--retries');
      const wakeStatePath = path.resolve(String(options['state-file'] ?? path.join(stateDir, `wake-${marker}.json`)));
      const wakeLogPath = path.join(logDir, `wake-${marker}.log`);
      await resumeThread(client, metadata.id);
      const previousTurn = await activeTurn(client, metadata.id);
      if (!previousTurn) throw new Error('No active turn was found to wait for. Arm wake-after-turn while a turn is active.');

      const state = {
        schemaVersion: 1,
        marker,
        phase: 'armed',
        controllerPid: process.pid,
        endpoint: endpoint.url,
        threadId: metadata.id,
        previousTurnId: previousTurn.id,
        nextTurnId: null,
        armedAt: nowIso(),
        updatedAt: nowIso(),
        message,
      };
      atomicWriteJson(wakeStatePath, state);
      appendLog(wakeLogPath, 'armed', state);
      print({ armed: true, marker, controllerPid: process.pid, threadId: metadata.id, previousTurnId: previousTurn.id, statePath: wakeStatePath });

      await client.waitFor(
        notificationFor('turn/completed', metadata.id, previousTurn.id),
        timeoutMilliseconds,
        Date.now(),
      );
      state.phase = 'previous-turn-completed';
      state.previousTurnCompletedAt = nowIso();
      state.updatedAt = nowIso();
      atomicWriteJson(wakeStatePath, state);
      appendLog(wakeLogPath, 'previous-turn-completed', { turnId: previousTurn.id });
      beep('completed');
      await sleep(delayMilliseconds);

      let startResult = null;
      let lastError = null;
      for (let attempt = 1; attempt <= retries; attempt += 1) {
        const requestedAt = Date.now();
        try {
          startResult = await client.call('turn/start', {
            threadId: metadata.id,
            input: userInput(`${message}\ncontroller_marker=${marker}\nretry_attempt=${attempt}`),
          });
          const expectedTurnId = startResult.turn?.id ?? null;
          const started = await client.waitFor(
            (notification) => notificationFor('turn/started', metadata.id, expectedTurnId)(notification)
              || (expectedTurnId === null && notificationFor('turn/started', metadata.id)(notification)),
            15_000,
            requestedAt,
          );
          state.nextTurnId = expectedTurnId ?? started.params?.turn?.id ?? null;
          state.startAttempt = attempt;
          lastError = null;
          break;
        } catch (error) {
          lastError = error;
          appendLog(wakeLogPath, 'turn-start-attempt-failed', { attempt, error: error.message });
          await sleep(2_000 * attempt);
        }
      }
      if (lastError || !state.nextTurnId) throw lastError ?? new Error('The next turn did not start.');

      state.phase = 'next-turn-started';
      state.nextTurnStartedAt = nowIso();
      state.updatedAt = nowIso();
      atomicWriteJson(wakeStatePath, state);
      appendLog(wakeLogPath, 'next-turn-started', { turnId: state.nextTurnId });
      beep('started');

      await client.waitFor(
        notificationFor('turn/completed', metadata.id, state.nextTurnId),
        timeoutMilliseconds,
        Date.now(),
      );
      state.phase = 'completed';
      state.nextTurnCompletedAt = nowIso();
      state.updatedAt = nowIso();
      atomicWriteJson(wakeStatePath, state);
      appendLog(wakeLogPath, 'completed', { turnId: state.nextTurnId });
      beep('completed');
      return;
    }

    throw new Error(`Unknown command: ${command}\n${usage()}`);
  } finally {
    client.close();
  }
}

main().catch((error) => {
  process.stderr.write(`codex-control: ${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
