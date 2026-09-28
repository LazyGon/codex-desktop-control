import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import { isIP } from 'node:net';

const ROUTE = '/v1/tasks/list';
const MAX_REQUEST_BYTES = 8192;
const MAX_RESPONSE_BYTES = 2_000_000;
const INSTANCE_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}$/;

export function isTaskListHost(host) {
  if (host === '127.0.0.1') return true;
  if (isIP(host) !== 4) return false;
  const [first, second] = host.split('.').map(Number);
  return first === 100 && second >= 64 && second <= 127;
}

export function resolveMultiPcConfig(config) {
  if (!config.multiPcEnabled) return config;
  // Preserve stored category IDs, but never adopt another PC's category by name.
  const suffix = ` [${config.instanceId}]`;
  const scoped = { ...config };
  for (const field of ['controlCategoryName', 'archiveCategoryName', 'transferCategoryName', 'chatgptCategoryName']) {
    scoped[field] = `${config[field]}${suffix}`;
  }
  scoped.projectCategoryPrefix = `${config.projectCategoryPrefix}${config.instanceId} - `;
  return scoped;
}

export function multiPcConfigErrors(config) {
  const errors = [];
  if (typeof config.multiPcEnabled !== 'boolean') errors.push('multiPcEnabled must be boolean.');
  if (!config.multiPcEnabled) return errors;
  if (!INSTANCE_PATTERN.test(config.instanceId ?? '')) errors.push('instanceId must be a unique safe ID of at most 32 characters.');
  if (!isTaskListHost(config.taskListListenHost)) errors.push('taskListListenHost must be a Tailscale IPv4 address or 127.0.0.1.');
  if (!Number.isInteger(config.taskListListenPort) || config.taskListListenPort < 1 || config.taskListListenPort > 65535) {
    errors.push('taskListListenPort must be a TCP port.');
  }
  if (!Number.isInteger(config.taskListPeerTimeoutMs) || config.taskListPeerTimeoutMs < 100 || config.taskListPeerTimeoutMs > 30000) {
    errors.push('taskListPeerTimeoutMs must be from 100 to 30000.');
  }
  const ids = new Set([config.instanceId]);
  const urls = new Set();
  if (!Array.isArray(config.taskListPeers) || config.taskListPeers.length > 16) errors.push('taskListPeers must be an array of at most 16 peers.');
  else for (const peer of config.taskListPeers) {
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

function sign(key, timestamp, body) {
  return createHmac('sha256', key).update(`${timestamp}\nPOST\n${ROUTE}\n${body}`).digest('hex');
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
  constructor({ config, token, getLocalTasks, fetchImpl = fetch }) {
    this.config = config;
    this.getLocalTasks = getLocalTasks;
    this.fetchImpl = fetchImpl;
    this.key = createHmac('sha256', token)
      .update(`codex-task-list-v1:${config.applicationId}:${config.guildId}`).digest();
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
  }

  async #handle(request, response) {
    if (request.method !== 'POST' || request.url !== ROUTE) {
      response.writeHead(404); response.end(); return;
    }
    const body = await readLimited(request, MAX_REQUEST_BYTES);
    const timestamp = request.headers['x-codex-timestamp'];
    const signature = request.headers['x-codex-signature'];
    const expected = sign(this.key, timestamp, body);
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
      || !this.config.authorizedUserIds.includes(input.userId)) {
      response.writeHead(403); response.end(); return;
    }
    if (typeof input.requestId !== 'string' || input.requestId.length > 80
      || typeof input.nonce !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(input.nonce)
      || (input.search !== null && (typeof input.search !== 'string' || input.search.length > 200))) {
      response.writeHead(400); response.end(); return;
    }
    const now = Date.now();
    for (const [nonce, seenAt] of this.seenNonces) if (now - seenAt > 60000) this.seenNonces.delete(nonce);
    if (this.seenNonces.has(input.nonce)) { response.writeHead(409); response.end(); return; }
    if (this.seenNonces.size >= 1000 || this.inFlight >= 4) { response.writeHead(503); response.end(); return; }
    this.seenNonces.set(input.nonce, now);
    this.inFlight += 1;
    try {
      const threads = await bounded(this.getLocalTasks(input.search), this.config.taskListPeerTimeoutMs);
      const snapshot = JSON.stringify({ schemaVersion: 1, requestId: input.requestId,
        instanceId: this.config.instanceId, threads: threads.map(taskListSummary) });
      if (Buffer.byteLength(snapshot) > MAX_RESPONSE_BYTES) throw new Error('Inventory too large.');
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(snapshot);
    } catch { response.writeHead(503); response.end(); }
    finally { this.inFlight -= 1; }
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
