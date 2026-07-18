import { EventEmitter } from 'node:events';

export class AppServerClient extends EventEmitter {
  constructor(url, { requestTimeoutMs = 30_000 } = {}) {
    super();
    this.url = url;
    this.requestTimeoutMs = requestTimeoutMs;
    this.socket = null;
    this.nextId = 1;
    this.pending = new Map();
    this.closedByClient = false;
  }

  get connected() {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  async connect() {
    this.closedByClient = false;
    this.socket = new WebSocket(this.url);
    this.socket.addEventListener('message', (event) => this.#handleMessage(event));
    this.socket.addEventListener('close', (event) => this.#handleClose(event));
    this.socket.addEventListener('error', (event) => this.emit('socketError', event));
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
    const result = await this.call('initialize', {
      clientInfo: { name: 'codex-discord-bridge', version: '1.0.0' },
      capabilities: { experimentalApi: true },
    });
    this.emit('ready', result);
    return result;
  }

  call(method, params = {}, timeoutMs = this.requestTimeoutMs) {
    if (!this.connected) return Promise.reject(new Error('Codex app-server WebSocket is not connected.'));
    const id = this.nextId;
    this.nextId += 1;
    this.socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs} ms.`));
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timeout });
    });
  }

  respond(id, result) {
    if (!this.connected) throw new Error('Cannot answer a Codex request while disconnected.');
    this.socket.send(JSON.stringify({ jsonrpc: '2.0', id, result }));
  }

  respondError(id, code, message, data = undefined) {
    if (!this.connected) throw new Error('Cannot answer a Codex request while disconnected.');
    const error = { code, message };
    if (data !== undefined) error.data = data;
    this.socket.send(JSON.stringify({ jsonrpc: '2.0', id, error }));
  }

  close() {
    this.closedByClient = true;
    try {
      this.socket?.close(1000, 'client shutdown');
    } catch {
      // Shutdown is best effort.
    }
    this.#rejectPending(new Error('Codex app-server connection closed.'));
  }

  #handleMessage(event) {
    let message;
    try {
      message = JSON.parse(String(event.data));
    } catch (error) {
      this.emit('protocolError', new Error(`Invalid JSON from app-server: ${error.message}`));
      return;
    }

    if (message.method && Object.hasOwn(message, 'id')) {
      this.emit('request', message);
      return;
    }
    if (message.method) {
      this.emit('notification', message);
      return;
    }
    if (Object.hasOwn(message, 'id') && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(pending.timeout);
      if (message.error) pending.reject(new Error(`${pending.method}: ${JSON.stringify(message.error)}`));
      else pending.resolve(message.result);
    }
  }

  #handleClose(event) {
    this.#rejectPending(new Error(`Codex app-server disconnected (${event.code}).`));
    this.emit('disconnected', { code: event.code, reason: event.reason, expected: this.closedByClient });
  }

  #rejectPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
