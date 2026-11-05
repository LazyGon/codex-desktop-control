import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { deliveryFor, listPages } from '../control/shared-task-operations.mjs';

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
    this.socket.addEventListener('close', () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timeout);
        pending.reject(new Error('Shared App Server disconnected; no request was retried.'));
      }
      this.pending.clear();
      for (const waiter of this.waiters) {
        clearTimeout(waiter.timeout);
        waiter.reject(new Error('Shared App Server disconnected.'));
      }
      this.waiters.clear();
    });
    await new Promise((resolve, reject) => {
      this.socket.addEventListener('open', () => {
        resolve();
      }, { once: true });
      this.socket.addEventListener('error', () => {
        reject(new Error(`Unable to connect to ${this.url}`));
      }, { once: true });
    });
    await this.call('initialize', {
      clientInfo: { name: 'codex-runtime-update-drain', version: '1.0.0' },
      capabilities: { experimentalApi: true },
    });
    this.socket.send(JSON.stringify({ jsonrpc: '2.0', method: 'initialized' }));
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
    for (const waiter of [...this.waiters]) {
      if (!waiter.predicate(notification)) continue;
      this.waiters.delete(waiter);
      clearTimeout(waiter.timeout);
      waiter.resolve(notification);
    }
  }

  call(method, params, timeoutMilliseconds = null) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('WebSocket is not open.'));
    }
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      const timeout = timeoutMilliseconds === null ? null : setTimeout(() => {
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

export async function inspectLoadedActivity(client) {
  async function loadedIds() {
    const rows = await listPages(client, 'thread/loaded/list', {});
    return [...new Set(rows.map(row => typeof row === 'string' ? row : row.id))];
  }
  const verified = new Set();
  for (const id of await loadedIds()) {
    let thread;
    try { ({ thread } = await client.call('thread/read', { threadId: id, includeTurns: false })); }
    catch (error) {
      const prefix = 'thread/read: ';
      if (!error.message.startsWith(prefix)) throw error;
      const detail = JSON.parse(error.message.slice(prefix.length));
      if (detail.code === -32600 && detail.message === 'thread not loaded: ' + id) continue;
      throw error;
    }
    if (thread?.id !== id || !['idle', 'active', 'notLoaded', 'systemError'].includes(thread.status?.type)) {
      throw new Error('Could not establish current activity for loaded thread ' + id);
    }
    if (thread.status.type === 'active') return { idle: false };
    verified.add(id);
  }
  return { idle: (await loadedIds()).every(id => verified.has(id)) };
}

function turnCompleted(notification, threadId, turnId) {
  if (notification.method !== 'turn/completed') return false;
  const turn = notification.params?.turn;
  const notificationThreadId = notification.params?.threadId ?? turn?.threadId;
  return notificationThreadId === threadId && turn?.id === turnId;
}

export async function deliverRuntimeCompletion(client, threadId, message) {
  const metadata = await client.call('thread/read', { threadId, includeTurns: false });
  if (metadata?.thread?.id !== threadId) throw new Error('Completion task identity mismatch.');
  if (metadata.thread.status?.type === 'notLoaded') {
    const resumed = await client.call('thread/resume', { threadId, excludeTurns: true });
    if (resumed?.thread?.id !== threadId) throw new Error('Resumed completion task identity mismatch.');
  }
  const turns = await client.call('thread/turns/list', {
    threadId, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded',
  });
  const active = turns.data?.find(turn => turn.status === 'inProgress') ?? null;
  const [method, params] = deliveryFor(threadId, active, message);
  const result = await client.call(method, params);
  const turnId = result?.turn?.id ?? result?.turnId;
  if (!turnId || (method === 'turn/steer' && turnId !== active.id)
      || (result.threadId && result.threadId !== threadId)) {
    throw new Error('Completion delivery uncertain; no replay is authorized.');
  }
  return { accepted: true, threadId, turnId, mode: method === 'turn/steer' ? 'steer' : 'start' };
}

export async function waitForTurnCompletion(client, threadId, turnId, timeoutMilliseconds = null) {
  const subscribedAt = Date.now();
  const deadline = timeoutMilliseconds === null ? Infinity : subscribedAt + timeoutMilliseconds;
  while (Date.now() < deadline) {
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

    const remaining = deadline - Date.now();
    try {
      const notification = await client.waitFor(
        (candidate) => turnCompleted(candidate, threadId, turnId),
        Math.min(1_000, remaining),
        subscribedAt,
      );
      return {
        threadId,
        turnId,
        status: notification.params?.turn?.status ?? 'completed',
        observedAt: nowIso(),
      };
    } catch (error) {
      if (error?.message !== 'Notification wait timed out.') throw error;
    }
  }
  throw new Error(`Turn wait timed out: ${turnId}`);
}

async function main() {
  const { positionals, options } = parseArguments(process.argv.slice(2));
  const command = positionals[0];
  const endpoint = requiredString(options.endpoint, '--endpoint');
  const client = new AppServerClient(endpoint);
  await client.connect();
  try {
    if (command === 'deliver') {
      const result = await deliverRuntimeCompletion(client,
        requiredString(options.thread, '--thread'), requiredString(options.message, '--message'));
      process.stdout.write(`${JSON.stringify(result)}\n`);
      return;
    }
    if (command === 'active') {
      process.stdout.write(JSON.stringify(await inspectLoadedActivity(client)) + '\n');
      return;
    }

    if (command === 'wait-turn') {
      const result = await waitForTurnCompletion(
        client,
        requiredString(options.thread, '--thread'),
        requiredString(options.turn, '--turn'),
        options['timeout-ms'] === undefined || options['timeout-ms'] === 'none'
          ? null : positiveInteger(options['timeout-ms'], null, '--timeout-ms'),
      );
      process.stdout.write(`${JSON.stringify(result)}\n`);
      return;
    }

    throw new Error('Usage: runtime-update-drain.mjs <active|wait-turn|deliver> [options]');
  } finally {
    client.close();
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  main().then(() => process.stdout.write('', () => process.exit(0))).catch((error) => {
    process.stderr.write(`runtime-update-drain: ${error.stack ?? error.message}\n`, () => process.exit(1));
  });
}
