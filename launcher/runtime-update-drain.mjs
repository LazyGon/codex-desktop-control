import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

function nowIso() {
  return new Date().toISOString();
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

function requiredString(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function positiveInteger(value, fallback, name) {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

function atomicWriteJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temporaryPath, filePath);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
}

function threadIsActive(thread) {
  return thread?.status === 'active' || thread?.status?.type === 'active';
}

export class AppServerClient {
  constructor(url) {
    this.url = url;
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
      clientInfo: { name: 'codex-runtime-update-drain', version: '1.0.0' },
      capabilities: { experimentalApi: true },
    });
  }

  #handleMessage(event) {
    const message = JSON.parse(String(event.data));
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
      if (!waiter.predicate(notification)) continue;
      this.waiters.delete(waiter);
      clearTimeout(waiter.timeout);
      waiter.resolve(notification);
    }
  }

  call(method, params, timeoutMilliseconds = 60_000) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('WebSocket is not open.'));
    }
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out.`));
      }, timeoutMilliseconds);
      this.pending.set(id, { method, resolve, reject, timeout });
      this.socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  }

  waitFor(predicate, timeoutMilliseconds, since = 0) {
    const existing = this.recentNotifications.find(
      (notification) => notification.receivedAt >= since && predicate(notification),
    );
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, reject, timeout: null };
      waiter.timeout = setTimeout(() => {
        this.waiters.delete(waiter);
        reject(new Error('Notification wait timed out.'));
      }, timeoutMilliseconds);
      this.waiters.add(waiter);
    });
  }

  close() {
    this.socket?.close();
  }
}

export async function listAllThreads(client) {
  const threads = [];
  const cursors = new Set();
  let cursor = null;
  do {
    const params = {
      limit: 100,
      archived: false,
      sortKey: 'recency_at',
      sortDirection: 'desc',
    };
    if (cursor) params.cursor = cursor;
    const result = await client.call('thread/list', params);
    threads.push(...(Array.isArray(result?.data) ? result.data : []));
    cursor = result?.nextCursor ?? null;
    if (cursor && cursors.has(cursor)) throw new Error(`thread/list repeated cursor: ${cursor}`);
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return threads;
}

export async function pauseActiveGoals(client, updateState, persist = () => {}) {
  const threads = await listAllThreads(client);
  const paused = new Set(updateState.pausedThreadIds ?? []);
  let nextState = {
    ...updateState,
    activeThreadIds: threads.filter(threadIsActive).map((thread) => thread.id).sort(),
    phase: 'draining',
    updatedAt: nowIso(),
  };
  for (const thread of threads) {
    const result = await client.call('thread/goal/get', { threadId: thread.id });
    if (result?.goal?.status !== 'active') continue;
    const updated = await client.call('thread/goal/set', {
      threadId: thread.id,
      status: 'paused',
    });
    if (updated?.goal?.status !== 'paused') {
      throw new Error(`Goal did not pause for thread ${thread.id}.`);
    }
    paused.add(thread.id);
    nextState = {
      ...nextState,
      pausedThreadIds: [...paused].sort(),
      updatedAt: nowIso(),
    };
    persist(nextState);
  }
  nextState = {
    ...nextState,
    pausedThreadIds: [...paused].sort(),
    updatedAt: nowIso(),
  };
  persist(nextState);
  return nextState;
}

export async function resumePausedGoals(client, updateState) {
  const resumedThreadIds = [];
  const unchangedThreadIds = [];
  for (const threadId of updateState.pausedThreadIds ?? []) {
    const result = await client.call('thread/goal/get', { threadId });
    if (result?.goal?.status !== 'paused') {
      unchangedThreadIds.push(threadId);
      continue;
    }
    const updated = await client.call('thread/goal/set', {
      threadId,
      status: 'active',
    });
    if (updated?.goal?.status !== 'active') {
      throw new Error(`Goal did not resume for thread ${threadId}.`);
    }
    resumedThreadIds.push(threadId);
  }
  return {
    ...updateState,
    phase: 'completed',
    activeThreadIds: [],
    resumedThreadIds: resumedThreadIds.sort(),
    unchangedThreadIds: unchangedThreadIds.sort(),
    completedAt: nowIso(),
    updatedAt: nowIso(),
  };
}

function turnCompleted(notification, threadId, turnId) {
  if (notification.method !== 'turn/completed') return false;
  const turn = notification.params?.turn;
  return notification.params?.threadId === threadId && turn?.id === turnId;
}

export async function waitForTurnCompletion(client, threadId, turnId, timeoutMilliseconds) {
  const subscribedAt = Date.now();
  const turns = await client.call('thread/turns/list', {
    threadId,
    limit: 100,
    sortDirection: 'desc',
    itemsView: 'notLoaded',
  });
  const target = (turns?.data ?? []).find((turn) => turn.id === turnId);
  if (!target) throw new Error(`Turn was not found: ${turnId}`);
  if (target.status !== 'inProgress') {
    return { threadId, turnId, status: target.status, observedAt: nowIso() };
  }
  const notification = await client.waitFor(
    (candidate) => turnCompleted(candidate, threadId, turnId),
    timeoutMilliseconds,
    subscribedAt,
  );
  return {
    threadId,
    turnId,
    status: notification.params?.turn?.status ?? 'completed',
    observedAt: nowIso(),
  };
}

async function main() {
  const { positionals, options } = parseArguments(process.argv.slice(2));
  const command = positionals[0];
  const endpoint = requiredString(options.endpoint, '--endpoint');
  const client = new AppServerClient(endpoint);
  await client.connect();
  try {
    if (command === 'pause-active') {
      const statePath = path.resolve(requiredString(options.state, '--state'));
      const fromVersion = requiredString(options['from-version'], '--from-version');
      const toVersion = requiredString(options['to-version'], '--to-version');
      let previous = fs.existsSync(statePath) ? readJson(statePath) : null;
      if (
        previous?.phase === 'completed' &&
        previous.toVersion === fromVersion &&
        previous.toVersion !== toVersion
      ) {
        previous = null;
      }
      previous ??= {
            schemaVersion: 1,
            phase: 'draining',
            fromVersion,
            toVersion,
            pausedThreadIds: [],
            startedAt: nowIso(),
          };
      if (previous.fromVersion !== fromVersion || previous.toVersion !== toVersion) {
        throw new Error(
          `Runtime update state targets ${previous.fromVersion} -> ${previous.toVersion}, ` +
          `not ${fromVersion} -> ${toVersion}.`,
        );
      }
      if (previous.phase === 'completed') {
        throw new Error('The runtime update state is already completed.');
      }
      const next = await pauseActiveGoals(
        client,
        previous,
        (state) => atomicWriteJson(statePath, state),
      );
      process.stdout.write(`${JSON.stringify(next)}\n`);
      return;
    }

    if (command === 'active') {
      const threads = await listAllThreads(client);
      process.stdout.write(`${JSON.stringify({
        activeThreadIds: threads.filter(threadIsActive).map((thread) => thread.id).sort(),
      })}\n`);
      return;
    }

    if (command === 'resume-paused') {
      const statePath = path.resolve(requiredString(options.state, '--state'));
      const previous = readJson(statePath);
      if (previous.phase === 'completed') {
        process.stdout.write(`${JSON.stringify(previous)}\n`);
        return;
      }
      const next = await resumePausedGoals(client, previous);
      atomicWriteJson(statePath, next);
      process.stdout.write(`${JSON.stringify(next)}\n`);
      return;
    }

    if (command === 'wait-turn') {
      const result = await waitForTurnCompletion(
        client,
        requiredString(options.thread, '--thread'),
        requiredString(options.turn, '--turn'),
        positiveInteger(options['timeout-ms'], 30 * 60_000, '--timeout-ms'),
      );
      process.stdout.write(`${JSON.stringify(result)}\n`);
      return;
    }

    throw new Error('Usage: runtime-update-drain.mjs <pause-active|active|resume-paused|wait-turn> [options]');
  } finally {
    client.close();
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`runtime-update-drain: ${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
