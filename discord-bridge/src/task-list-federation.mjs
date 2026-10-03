import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { isIP } from 'node:net';
import path from 'node:path';
import { taskOperationIsEffectful, validateTaskOperation } from './task-peer-control.mjs';

const ROUTE = '/v1/tasks/list';
const CONTROL_ROUTE = '/v1/tasks/operate';
const MAX_REQUEST_BYTES = 8192;
const MAX_CONTROL_REQUEST_BYTES = 32768;
const MAX_RESPONSE_BYTES = 2_000_000;
const INSTANCE_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}$/;

function readOperationJournal(filePath) {
  const records = {};
  if (!fs.existsSync(filePath)) return { schemaVersion: 1, records };
  const content = fs.readFileSync(filePath, 'utf8');
  if (content && !content.endsWith('\n')) throw new Error('Incomplete peer-operation journal.');
  for (const line of content.split('\n').filter(Boolean)) {
    const record = JSON.parse(line);
    if (record?.schemaVersion !== 1 || !/^[0-9a-f-]{36}$/i.test(record.requestId ?? '')
      || !/^[a-f0-9]{64}$/.test(record.fingerprint ?? '')
      || !['unknown', 'completed'].includes(record.state)) {
      throw new Error('Invalid peer-operation journal record.');
    }
    records[record.requestId] = record;
  }
  return { schemaVersion: 1, records };
}

export function isTaskListHost(host) {
  if (host === '127.0.0.1') return true;
  if (isIP(host) !== 4) return false;
  const [first, second] = host.split('.').map(Number);
  return first === 100 && second >= 64 && second <= 127;
}

export function resolveMultiPcConfig(config) {
  if (!config.multiPcEnabled) return config;
  // Preserve stored category IDs, but never adopt another PC's category by name.
  const categoryPcName = config.instanceDisplayName ?? config.instanceId;
  const suffix = ` [${categoryPcName}]`;
  const scoped = { ...config };
  for (const field of ['controlCategoryName', 'archiveCategoryName', 'transferCategoryName', 'chatgptCategoryName']) {
    scoped[field] = `${config[field]}${suffix}`;
  }
  scoped.projectCategoryPrefix = `${config.projectCategoryPrefix}${categoryPcName} - `;
  return scoped;
}

export function multiPcConfigErrors(config) {
  const errors = [];
  if (typeof config.multiPcEnabled !== 'boolean') errors.push('multiPcEnabled must be boolean.');
  if (!config.multiPcEnabled) return errors;
  if (!INSTANCE_PATTERN.test(config.instanceId ?? '')) errors.push('instanceId must be a unique safe ID of at most 32 characters.');
  if (config.instanceDisplayName != null && !INSTANCE_PATTERN.test(config.instanceDisplayName)) {
    errors.push('instanceDisplayName must be null or a safe name of at most 32 characters.');
  }
  if (!isTaskListHost(config.taskListListenHost)) errors.push('taskListListenHost must be a Tailscale IPv4 address or 127.0.0.1.');
  if (!Number.isInteger(config.taskListListenPort) || config.taskListListenPort < 1 || config.taskListListenPort > 65535) {
    errors.push('taskListListenPort must be a TCP port.');
  }
  if (!Number.isInteger(config.taskListPeerTimeoutMs) || config.taskListPeerTimeoutMs < 100 || config.taskListPeerTimeoutMs > 30000) {
    errors.push('taskListPeerTimeoutMs must be from 100 to 30000.');
  }
  if (config.taskControlEnabled !== undefined && typeof config.taskControlEnabled !== 'boolean') {
    errors.push('taskControlEnabled must be boolean.');
  }
  if (config.taskControlTimeoutMs !== undefined && (!Number.isInteger(config.taskControlTimeoutMs)
    || config.taskControlTimeoutMs < 1000 || config.taskControlTimeoutMs > 300000)) {
    errors.push('taskControlTimeoutMs must be from 1000 to 300000.');
  }
  const ids = new Set([config.instanceId]);
  const urls = new Set();
  if (!Array.isArray(config.taskListPeers) || config.taskListPeers.length > 16) errors.push('taskListPeers must be an array of at most 16 peers.');
  else for (const peer of config.taskListPeers) {
    if (peer?.allowTaskControl !== undefined && typeof peer.allowTaskControl !== 'boolean') {
      errors.push('allowTaskControl must be a boolean on each peer.');
    }
    if (!INSTANCE_PATTERN.test(peer?.instanceId ?? '') || ids.has(peer?.instanceId)) errors.push('Each task-list peer must have a unique instanceId.');
    ids.add(peer?.instanceId);
    try {
      const url = new URL(peer.url);
      if (url.protocol !== 'http:' || !isTaskListHost(url.hostname) || url.username || url.password
        || url.pathname !== '/' || url.search || url.hash || urls.has(url.origin)) throw new Error();
      urls.add(url.origin);
    } catch { errors.push('Each peer URL must be a unique bare HTTP Tailscale/loopback origin.'); }
  }
  return errors;
}

function sign(key, timestamp, body, route = ROUTE) {
  return createHmac('sha256', key).update(`${timestamp}\nPOST\n${route}\n${body}`).digest('hex');
}

async function readLimited(stream, maximum) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > maximum) throw new Error('Payload too large.');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function bounded(promise, timeoutMs) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Task list timed out.')), timeoutMs);
  })]).finally(() => clearTimeout(timer));
}

export function mergeTaskLists(snapshots) {
  const tasks = new Map();
  for (const snapshot of snapshots) {
    for (const thread of snapshot.threads ?? []) {
      // The same UUID on two independent PCs must not silently choose one owner.
      tasks.set(`${snapshot.instanceId}:${thread.id}`, { ...thread, instanceId: snapshot.instanceId });
    }
  }
  return [...tasks.values()].sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0)
    || `${left.instanceId}:${left.id}`.localeCompare(`${right.instanceId}:${right.id}`));
}

export function taskListSummary(thread) {
  return {
    id: String(thread.id).slice(0, 64),
    name: String(thread.name ?? '(untitled)').slice(0, 300),
    cwd: String(thread.cwd ?? '(no cwd)').slice(0, 1000),
    status: { type: String(thread.status?.type ?? 'unknown').slice(0, 32) },
    updatedAt: Number(thread.updatedAt) || 0,
  };
}

export class TaskListFederation {
  constructor({ config, token, getLocalTasks, executeLocalOperation = null,
    operationJournalPath = null, fetchImpl = fetch }) {
    this.config = config;
    this.getLocalTasks = getLocalTasks;
    this.executeLocalOperation = executeLocalOperation;
    this.operationJournalPath = operationJournalPath;
    this.fetchImpl = fetchImpl;
    this.key = createHmac('sha256', token)
      .update(`codex-task-list-v1:${config.applicationId}:${config.guildId}`).digest();
    this.controlKey = createHmac('sha256', token)
      .update(`codex-task-control-v1:${config.applicationId}:${config.guildId}`).digest();
    this.controlReady = Boolean(config.taskControlEnabled && executeLocalOperation && operationJournalPath);
    this.controlFailureCode = null;
    try {
      this.operationJournal = operationJournalPath ? readOperationJournal(operationJournalPath)
        : { schemaVersion: 1, records: {} };
    } catch {
      // A damaged journal disables effects, never ordinary Discord or lists.
      this.operationJournal = { schemaVersion: 1, records: {} };
      this.controlReady = false;
      this.controlFailureCode = 'JOURNAL_INVALID';
    }
    if (config.taskControlEnabled && !this.controlReady && !this.controlFailureCode) {
      this.controlFailureCode = 'HANDLER_UNAVAILABLE';
    }
    this.seenNonces = new Map();
    this.server = null;
    this.inFlight = 0;
  }

  async start() {
    if (this.server) return;
    const errors = multiPcConfigErrors(this.config);
    if (errors.length) throw new Error(errors.join('\n'));
    const server = http.createServer((request, response) => {
      this.#handle(request, response).catch(() => {
        if (!response.headersSent) response.writeHead(400);
        response.end();
      });
    });
    // Only reading a request body gets ten seconds. Execution has its own
    // longer bounded deadline after authentication has completed.
    server.requestTimeout = 10000;
    server.headersTimeout = 10000;
    server.maxConnections = 16;
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.config.taskListListenPort, this.config.taskListListenHost, resolve);
    }).catch((error) => { server.close(); throw error; });
    server.removeAllListeners('error');
    // A failed peer-list listener must not take down ordinary Discord execution.
    server.on('error', () => {});
    this.server = server;
  }

  async stop() {
    const server = this.server;
    this.server = null;
    if (server) {
      const closed = new Promise((resolve) => server.close(resolve));
      server.closeAllConnections();
      await closed;
    }
    this.key.fill(0);
    this.controlKey.fill(0);
  }

  async #handle(request, response) {
    const control = request.url === CONTROL_ROUTE && this.controlReady;
    if (request.method !== 'POST' || (request.url !== ROUTE && !control)) {
      response.writeHead(404); response.end(); return;
    }
    const body = await readLimited(request, control ? MAX_CONTROL_REQUEST_BYTES : MAX_REQUEST_BYTES);
    const timestamp = request.headers['x-codex-timestamp'];
    const signature = request.headers['x-codex-signature'];
    const expected = sign(control ? this.controlKey : this.key, timestamp, body, request.url);
    if (!/^\d{13}$/.test(String(timestamp)) || Math.abs(Date.now() - Number(timestamp)) > 30000
      || !/^[a-f0-9]{64}$/.test(String(signature))
      || !timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'))) {
      response.writeHead(401); response.end(); return;
    }
    const input = JSON.parse(body);
    const peer = this.config.taskListPeers.find((entry) => entry.instanceId === input.instanceId);
    const remoteAddress = String(request.socket.remoteAddress).replace(/^::ffff:/, '');
    if (!peer || new URL(peer.url).hostname !== remoteAddress
      || input.guildId !== this.config.guildId
      || !this.config.authorizedUserIds.includes(input.userId)
      || (control && (!peer.allowTaskControl || input.targetInstanceId !== this.config.instanceId))) {
      response.writeHead(403); response.end(); return;
    }
    if (typeof input.requestId !== 'string' || input.requestId.length > 80 || !input.requestId
      || typeof input.nonce !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(input.nonce)
      || (!control && input.search !== null && (typeof input.search !== 'string' || input.search.length > 200))) {
      response.writeHead(400); response.end(); return;
    }
    if (control) {
      try { validateTaskOperation(input.operation); }
      catch { response.writeHead(400); response.end(); return; }
      if (!/^[0-9a-f-]{36}$/i.test(input.requestId)) {
        response.writeHead(400); response.end(); return;
      }
    }
    const now = Date.now();
    for (const [nonce, seenAt] of this.seenNonces) if (now - seenAt > 60000) this.seenNonces.delete(nonce);
    if (this.seenNonces.has(input.nonce)) { response.writeHead(409); response.end(); return; }
    if (this.seenNonces.size >= 1000 || this.inFlight >= 4) { response.writeHead(503); response.end(); return; }
    this.seenNonces.set(input.nonce, now);
    this.inFlight += 1;
    try {
      if (control) {
        await this.#operate(input, response);
        return;
      }
      const threads = await bounded(this.getLocalTasks(input.search), this.config.taskListPeerTimeoutMs);
      const snapshot = JSON.stringify({ schemaVersion: 1, requestId: input.requestId,
        instanceId: this.config.instanceId, threads: threads.map(taskListSummary) });
      if (Buffer.byteLength(snapshot) > MAX_RESPONSE_BYTES) throw new Error('Inventory too large.');
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(snapshot);
    } catch { response.writeHead(503); response.end(); }
    finally { this.inFlight -= 1; }
  }

  #recordOperation(requestId, record) {
    const entry = { schemaVersion: 1, requestId, ...record };
    fs.mkdirSync(path.dirname(this.operationJournalPath), { recursive: true });
    const descriptor = fs.openSync(this.operationJournalPath, 'a', 0o600);
    try {
      fs.writeFileSync(descriptor, `${JSON.stringify(entry)}\n`, 'utf8');
      fs.fsyncSync(descriptor);
    } finally { fs.closeSync(descriptor); }
    // No effect starts until the initial 'unknown' record is flushed. A
    // truncated write fails closed when the Bridge next loads the journal.
    this.operationJournal.records[requestId] = entry;
  }

  async #operate(input, response) {
    const operation = input.operation;
    const effect = taskOperationIsEffectful(operation.action);
    const fingerprint = createHash('sha256').update(JSON.stringify({
      instanceId: input.instanceId, userId: input.userId, operation,
    })).digest('hex');
    const existing = this.operationJournal.records[input.requestId];
    if (existing && existing.fingerprint !== fingerprint) {
      response.writeHead(409); response.end(); return;
    }
    if (existing) {
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(JSON.stringify({ schemaVersion: 1, requestId: input.requestId,
        instanceId: this.config.instanceId, state: existing.state, result: existing.result ?? null }));
      return;
    }
    if (effect) {
      if (Object.keys(this.operationJournal.records).length >= 10000) {
        response.writeHead(503); response.end(); return;
      }
      try { this.#recordOperation(input.requestId, { fingerprint, state: 'unknown', at: Date.now() }); }
      catch { response.writeHead(503); response.end(); return; }
    }
    let outcome;
    try {
      const result = await bounded(this.executeLocalOperation(operation), this.config.taskControlTimeoutMs ?? 60000);
      outcome = { state: 'completed', result };
      if (Buffer.byteLength(JSON.stringify(outcome)) > MAX_RESPONSE_BYTES) throw new Error('Result too large.');
    } catch { outcome = { state: 'unknown', result: null }; }
    if (effect) {
      try { this.#recordOperation(input.requestId, { fingerprint, ...outcome, at: Date.now() }); }
      catch { outcome = { state: 'unknown', result: null }; }
    }
    response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    response.end(JSON.stringify({ schemaVersion: 1, requestId: input.requestId,
      instanceId: this.config.instanceId, ...outcome }));
  }

  async #peerTasks(peer, { requestId, userId, search }) {
    const body = JSON.stringify({ instanceId: this.config.instanceId, guildId: this.config.guildId,
      requestId, userId, search, nonce: randomUUID() });
    const timestamp = String(Date.now());
    const response = await this.fetchImpl(`${new URL(peer.url).origin}${ROUTE}`, {
      method: 'POST', redirect: 'error',
      headers: { 'content-type': 'application/json', 'x-codex-timestamp': timestamp,
        'x-codex-signature': sign(this.key, timestamp, body) },
      body, signal: AbortSignal.timeout(this.config.taskListPeerTimeoutMs),
    });
    if (!response.ok) throw new Error('Peer unavailable.');
    const snapshot = JSON.parse(await readLimited(response.body, MAX_RESPONSE_BYTES));
    if (snapshot.schemaVersion !== 1 || snapshot.instanceId !== peer.instanceId
      || snapshot.requestId !== requestId || !Array.isArray(snapshot.threads)
      || snapshot.threads.some((thread) => !thread || typeof thread.id !== 'string' || !thread.id)) {
      throw new Error('Invalid peer inventory.');
    }
    return { instanceId: peer.instanceId, threads: snapshot.threads.map(taskListSummary) };
  }

  async listPeer({ instanceId, userId, search = null, requestId = randomUUID() }) {
    if (!this.config.authorizedUserIds.includes(userId)) throw new Error('Operator is not authorized.');
    const peer = this.config.taskListPeers.find((entry) => entry.instanceId === instanceId);
    if (!peer) throw new Error('Unknown peer PC.');
    return this.#peerTasks(peer, { requestId, userId, search });
  }

  async operatePeer({ instanceId, userId, operation, requestId = randomUUID() }) {
    validateTaskOperation(operation);
    if (!this.config.taskControlEnabled || !this.config.authorizedUserIds.includes(userId)) {
      throw new Error('Peer task control is not enabled for this operator.');
    }
    const peer = this.config.taskListPeers.find((entry) => entry.instanceId === instanceId);
    if (!peer?.allowTaskControl) throw new Error('Task control is not allowed for this peer.');
    if (!/^[0-9a-f-]{36}$/i.test(requestId)) throw new Error('Operation ID must be a UUID.');
    const body = JSON.stringify({ instanceId: this.config.instanceId,
      targetInstanceId: peer.instanceId, guildId: this.config.guildId, userId,
      requestId, nonce: randomUUID(), operation });
    const timestamp = String(Date.now());
    const response = await this.fetchImpl(`${new URL(peer.url).origin}${CONTROL_ROUTE}`, {
      method: 'POST', redirect: 'error',
      headers: { 'content-type': 'application/json', connection: 'close', 'x-codex-timestamp': timestamp,
        'x-codex-signature': sign(this.controlKey, timestamp, body, CONTROL_ROUTE) },
      body, signal: AbortSignal.timeout((this.config.taskControlTimeoutMs ?? 60000) + 1000),
    });
    if (!response.ok) throw new Error(`Peer task control failed (HTTP ${response.status}); operation ${requestId} may need checking.`);
    const result = JSON.parse(await readLimited(response.body, MAX_RESPONSE_BYTES));
    if (result.schemaVersion !== 1 || result.instanceId !== peer.instanceId
      || result.requestId !== requestId || !['completed', 'unknown'].includes(result.state)) {
      throw new Error('Invalid peer operation response.');
    }
    return result;
  }

  async collect({ requestId, userId, search = null }) {
    if (!this.config.authorizedUserIds.includes(userId)) throw new Error('Task-list operator is not authorized.');
    const sources = [
      { instanceId: this.config.instanceId, operation: () => bounded(this.getLocalTasks(search), this.config.taskListPeerTimeoutMs)
        .then((threads) => ({ instanceId: this.config.instanceId, threads: threads.map(taskListSummary) })) },
      ...this.config.taskListPeers.map((peer) => ({ instanceId: peer.instanceId,
        operation: () => this.#peerTasks(peer, { requestId, userId, search }) })),
    ];
    const results = await Promise.all(sources.map(async (source) => {
      try { return { ...await source.operation(), available: true }; }
      catch { return { instanceId: source.instanceId, threads: [], available: false }; }
    }));
    return { threads: mergeTaskLists(results), sources: results.map(({ instanceId, available }) => ({ instanceId, available })) };
  }
}
