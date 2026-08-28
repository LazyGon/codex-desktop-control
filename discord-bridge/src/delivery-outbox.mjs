import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import {
  atomicWriteJson,
  nowIso,
  readJsonIfPresent,
} from './util.mjs';

const SCHEMA_VERSION = 1;
const RECOVERY_CURSOR_SCHEMA_VERSION = 1;
const DELIVERY_STATES = new Set(['queued', 'attempting', 'uncertain', 'accepted', 'rejected']);
const CALLBACK_STATES = new Set(['pending', 'delivering', 'delivered', 'uncertain', 'notRequired']);

function entryKey(requestId) {
  return createHash('sha256').update(String(requestId)).digest('hex');
}

export function discordSnowflakeAt(timestampMs = Date.now()) {
  const discordEpochMs = 1_420_070_400_000n;
  const timestamp = BigInt(Math.max(1_420_070_400_000, Math.floor(Number(timestampMs))));
  return ((timestamp - discordEpochMs) << 22n).toString();
}

function assertSnowflake(value, label) {
  if (!/^\d+$/.test(String(value ?? ''))) throw new Error(`${label} must be a Discord snowflake.`);
  return String(value);
}

function assertRecoveryCursor(cursor) {
  if (!cursor || cursor.schemaVersion !== RECOVERY_CURSOR_SCHEMA_VERSION
    || !cursor.cutoverMessageId || !cursor.channels || typeof cursor.channels !== 'object') {
    throw new Error('Discord recovery cursor is missing or invalid.');
  }
  assertSnowflake(cursor.cutoverMessageId, 'Discord recovery cutover');
  for (const [channelId, messageId] of Object.entries(cursor.channels)) {
    if (!channelId) throw new Error('Discord recovery cursor contains an empty channel ID.');
    assertSnowflake(messageId, `Discord recovery cursor for ${channelId}`);
  }
}

function processIsAlive(processId) {
  if (!Number.isSafeInteger(processId) || processId <= 0) return false;
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function failureRecord(error, code = 'DELIVERY_FAILED') {
  return {
    code,
    message: String(error?.message ?? error ?? code),
  };
}

function assertEntry(entry, requestId) {
  if (!entry || entry.schemaVersion !== SCHEMA_VERSION || entry.requestId !== requestId) {
    throw new Error(`Delivery outbox entry is missing or invalid for ${requestId}.`);
  }
  if (!DELIVERY_STATES.has(entry.state) || !CALLBACK_STATES.has(entry.callback?.state)) {
    throw new Error(`Delivery outbox entry has an invalid state for ${requestId}.`);
  }
}

function sameEnqueueRequest(entry, request) {
  return entry.threadId === request.threadId
    && entry.prompt === request.prompt
    && JSON.stringify(entry.attachments ?? []) === JSON.stringify(request.attachments ?? [])
    && JSON.stringify(entry.source ?? {}) === JSON.stringify(request.source ?? {});
}

export class DeliveryOutboxLockedError extends Error {
  constructor(requestId) {
    super(`Delivery outbox entry is locked: ${requestId}`);
    this.name = 'DeliveryOutboxLockedError';
    this.code = 'DELIVERY_OUTBOX_LOCKED';
  }
}

export class DeliveryOutbox {
  constructor(directory, {
    ownerPid = process.pid,
    clock = () => nowIso(),
    uuid = randomUUID,
    isProcessAlive = processIsAlive,
  } = {}) {
    this.directory = directory;
    this.ownerPid = ownerPid;
    this.clock = clock;
    this.uuid = uuid;
    this.isProcessAlive = isProcessAlive;
  }

  ensureDirectory() {
    fs.mkdirSync(this.directory, { recursive: true });
  }

  filePath(requestId) {
    return path.join(this.directory, `${entryKey(requestId)}.json`);
  }

  lockPath(requestId) {
    return path.join(this.directory, `${entryKey(requestId)}.lock`);
  }

  recoveryCursorPath() {
    return path.join(this.directory, 'recovery-cursor.json');
  }

  recoveryCursor() {
    const filePath = this.recoveryCursorPath();
    if (!fs.existsSync(filePath)) return null;
    const cursor = readJsonIfPresent(filePath);
    assertRecoveryCursor(cursor);
    return cursor;
  }

  initializeRecoveryCursor(cutoverMessageId) {
    const cutover = assertSnowflake(cutoverMessageId, 'Discord recovery cutover');
    return this.#mutateRecoveryCursor((current) => {
      if (current) {
        assertRecoveryCursor(current);
        return current;
      }
      const timestamp = this.clock();
      return {
        schemaVersion: RECOVERY_CURSOR_SCHEMA_VERSION,
        cutoverMessageId: cutover,
        channels: {},
        createdAt: timestamp,
        updatedAt: timestamp,
      };
    });
  }

  channelRecoveryCursor(channelId) {
    const cursor = this.recoveryCursor();
    if (!cursor) throw new Error('Discord recovery cursor has not been initialized.');
    return cursor.channels[channelId] ?? cursor.cutoverMessageId;
  }

  advanceChannelRecoveryCursor(channelId, messageId) {
    if (!String(channelId ?? '').trim()) throw new Error('Discord recovery channelId is required.');
    const nextMessageId = assertSnowflake(messageId, `Discord recovery cursor for ${channelId}`);
    return this.#mutateRecoveryCursor((cursor) => {
      assertRecoveryCursor(cursor);
      const currentMessageId = cursor.channels[channelId] ?? cursor.cutoverMessageId;
      if (BigInt(nextMessageId) <= BigInt(currentMessageId)) return cursor;
      const timestamp = this.clock();
      return {
        ...cursor,
        channels: { ...cursor.channels, [channelId]: nextMessageId },
        updatedAt: timestamp,
      };
    });
  }

  get(requestId) {
    const filePath = this.filePath(requestId);
    if (!fs.existsSync(filePath)) return null;
    const entry = readJsonIfPresent(filePath);
    assertEntry(entry, requestId);
    return entry;
  }

  list({ states = null, callbackStates = null } = {}) {
    this.ensureDirectory();
    const deliveryFilter = states ? new Set(states) : null;
    const callbackFilter = callbackStates ? new Set(callbackStates) : null;
    return fs.readdirSync(this.directory)
      .filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
      .map((name) => {
        const entry = readJsonIfPresent(path.join(this.directory, name));
        assertEntry(entry, entry?.requestId);
        if (name !== `${entryKey(entry.requestId)}.json`) {
          throw new Error(`Delivery outbox filename does not match requestId: ${entry.requestId}`);
        }
        return entry;
      })
      .filter((entry) => (!deliveryFilter || deliveryFilter.has(entry.state))
        && (!callbackFilter || callbackFilter.has(entry.callback.state)))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt)
        || left.requestId.localeCompare(right.requestId));
  }

  enqueue({ requestId, threadId, prompt, attachments = [], source }) {
    if (!String(requestId ?? '').trim()) throw new Error('Delivery requestId is required.');
    if (!String(threadId ?? '').trim()) throw new Error('Delivery threadId is required.');
    if (!String(prompt ?? '').trim()) throw new Error('Delivery prompt is required.');
    return this.#mutate(requestId, (existing) => {
      if (existing) {
        assertEntry(existing, requestId);
        if (!sameEnqueueRequest(existing, { threadId, prompt, attachments, source })) {
          throw new Error(`Delivery requestId payload mismatch: ${requestId}`);
        }
        return existing;
      }
      const timestamp = this.clock();
      return {
        schemaVersion: SCHEMA_VERSION,
        requestId,
        threadId,
        prompt,
        attachments,
        source,
        state: 'queued',
        attempt: null,
        receipt: null,
        failure: null,
        callback: {
          state: 'pending',
          attemptId: null,
          ownerPid: null,
          startedAt: null,
          completedAt: null,
          outcome: null,
          failure: null,
        },
        createdAt: timestamp,
        updatedAt: timestamp,
      };
    });
  }

  beginAttempt(requestId, target) {
    return this.#mutate(requestId, (entry) => {
      assertEntry(entry, requestId);
      if (entry.state !== 'queued') throw new Error(`Delivery is not queued: ${requestId} (${entry.state})`);
      const attemptId = this.uuid();
      const timestamp = this.clock();
      return {
        ...entry,
        state: 'attempting',
        attempt: {
          attemptId,
          requestId,
          ownerPid: this.ownerPid,
          mode: target.mode,
          expectedTurnId: target.expectedTurnId ?? null,
          startedAt: timestamp,
        },
        updatedAt: timestamp,
      };
    });
  }

  accept(requestId, { attemptId, mode, turnId }) {
    return this.#mutate(requestId, (entry) => {
      this.#assertAttempt(entry, requestId, attemptId);
      if (!turnId) throw new Error(`Accepted delivery is missing its exact turn ID: ${requestId}`);
      const timestamp = this.clock();
      return {
        ...entry,
        state: 'accepted',
        receipt: {
          requestId,
          attemptId,
          mode,
          turnId,
          acceptedAt: timestamp,
          reconciled: false,
        },
        updatedAt: timestamp,
      };
    });
  }

  acceptReconciled(requestId, { turnId, mode = null }) {
    return this.#mutate(requestId, (entry) => {
      assertEntry(entry, requestId);
      if (entry.state !== 'uncertain') {
        throw new Error(`Only an uncertain delivery can be reconciled: ${requestId} (${entry.state})`);
      }
      if (!turnId) throw new Error(`Reconciled delivery is missing its exact turn ID: ${requestId}`);
      const timestamp = this.clock();
      return {
        ...entry,
        state: 'accepted',
        receipt: {
          requestId,
          attemptId: entry.attempt?.attemptId ?? null,
          mode: mode ?? entry.attempt?.mode ?? null,
          turnId,
          acceptedAt: timestamp,
          reconciled: true,
        },
        failure: null,
        updatedAt: timestamp,
      };
    });
  }

  markUncertain(requestId, { attemptId, error, code = 'DELIVERY_ACCEPTANCE_UNCERTAIN' }) {
    return this.#mutate(requestId, (entry) => {
      this.#assertAttempt(entry, requestId, attemptId);
      const timestamp = this.clock();
      return {
        ...entry,
        state: 'uncertain',
        failure: failureRecord(error, code),
        updatedAt: timestamp,
      };
    });
  }

  reject(requestId, { error, code = 'DELIVERY_REJECTED' }) {
    return this.#mutate(requestId, (entry) => {
      assertEntry(entry, requestId);
      if (entry.state !== 'queued') throw new Error(`Only a queued delivery can be rejected: ${requestId} (${entry.state})`);
      const timestamp = this.clock();
      return {
        ...entry,
        state: 'rejected',
        failure: failureRecord(error, code),
        updatedAt: timestamp,
      };
    });
  }

  beginCallback(requestId) {
    return this.#mutate(requestId, (entry) => {
      assertEntry(entry, requestId);
      if (!['accepted', 'rejected', 'uncertain'].includes(entry.state)
        || entry.callback.state !== 'pending') {
        throw new Error(`Delivery callback is not pending: ${requestId} (${entry.state}/${entry.callback.state})`);
      }
      const timestamp = this.clock();
      return {
        ...entry,
        callback: {
          ...entry.callback,
          state: 'delivering',
          attemptId: this.uuid(),
          ownerPid: this.ownerPid,
          startedAt: timestamp,
        },
        updatedAt: timestamp,
      };
    });
  }

  completeCallback(requestId, { attemptId, outcome }) {
    return this.#mutate(requestId, (entry) => {
      this.#assertCallback(entry, requestId, attemptId);
      const timestamp = this.clock();
      return {
        ...entry,
        callback: {
          ...entry.callback,
          state: 'delivered',
          completedAt: timestamp,
          outcome,
          failure: null,
        },
        updatedAt: timestamp,
      };
    });
  }

  markCallbackUncertain(requestId, { attemptId, error }) {
    return this.#mutate(requestId, (entry) => {
      this.#assertCallback(entry, requestId, attemptId);
      const timestamp = this.clock();
      return {
        ...entry,
        callback: {
          ...entry.callback,
          state: 'uncertain',
          completedAt: timestamp,
          failure: failureRecord(error, 'CALLBACK_UNCERTAIN'),
        },
        updatedAt: timestamp,
      };
    });
  }

  recoverStaleOwnership() {
    const recovered = [];
    for (const original of this.list()) {
      let kind = null;
      if (original.state === 'attempting' && !this.isProcessAlive(original.attempt?.ownerPid)) {
        kind = 'delivery';
      } else if (original.callback.state === 'delivering'
        && !this.isProcessAlive(original.callback.ownerPid)) {
        kind = 'callback';
      }
      if (!kind) continue;
      const entry = this.#mutate(original.requestId, (current) => {
        assertEntry(current, original.requestId);
        const timestamp = this.clock();
        if (kind === 'delivery' && current.state === 'attempting'
          && !this.isProcessAlive(current.attempt?.ownerPid)) {
          return {
            ...current,
            state: 'uncertain',
            failure: failureRecord('The previous delivery owner exited before recording acceptance.', 'STALE_DELIVERY_OWNER'),
            updatedAt: timestamp,
          };
        }
        if (kind === 'callback' && current.callback.state === 'delivering'
          && !this.isProcessAlive(current.callback.ownerPid)) {
          return {
            ...current,
            callback: {
              ...current.callback,
              state: 'uncertain',
              completedAt: timestamp,
              failure: failureRecord('The previous callback owner exited before recording completion.', 'STALE_CALLBACK_OWNER'),
            },
            updatedAt: timestamp,
          };
        }
        return current;
      });
      recovered.push({ requestId: original.requestId, kind, state: entry.state, callbackState: entry.callback.state });
    }
    return recovered;
  }

  #assertAttempt(entry, requestId, attemptId) {
    assertEntry(entry, requestId);
    if (entry.state !== 'attempting' || !attemptId || entry.attempt?.attemptId !== attemptId
      || entry.attempt.requestId !== requestId) {
      throw new Error(`Delivery attempt receipt mismatch: ${requestId}`);
    }
  }

  #assertCallback(entry, requestId, attemptId) {
    assertEntry(entry, requestId);
    if (!['accepted', 'rejected', 'uncertain'].includes(entry.state)
      || entry.callback.state !== 'delivering'
      || !attemptId || entry.callback.attemptId !== attemptId) {
      throw new Error(`Delivery callback receipt mismatch: ${requestId}`);
    }
  }

  #mutate(requestId, mutation) {
    this.ensureDirectory();
    const lockPath = this.lockPath(requestId);
    return this.#withLock(lockPath, requestId, () => {
      const filePath = this.filePath(requestId);
      const fileExists = fs.existsSync(filePath);
      const current = readJsonIfPresent(filePath);
      if (fileExists && !current) {
        throw new Error(`Delivery outbox entry cannot be parsed: ${requestId}`);
      }
      const next = mutation(current);
      if (next !== current) atomicWriteJson(filePath, next);
      return next;
    });
  }

  #mutateRecoveryCursor(mutation) {
    this.ensureDirectory();
    const filePath = this.recoveryCursorPath();
    return this.#withLock(
      path.join(this.directory, 'recovery-cursor.lock'),
      'discord-recovery-cursor',
      () => {
        const fileExists = fs.existsSync(filePath);
        const current = readJsonIfPresent(filePath);
        if (fileExists && !current) throw new Error('Discord recovery cursor cannot be parsed.');
        const next = mutation(current);
        if (next !== current) atomicWriteJson(filePath, next);
        return next;
      },
    );
  }

  #withLock(lockPath, lockId, operation) {
    let lockHandle = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        lockHandle = fs.openSync(lockPath, 'wx');
        fs.writeFileSync(lockHandle, `${JSON.stringify({ ownerPid: this.ownerPid, createdAt: this.clock() })}\n`, 'utf8');
        break;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const owner = readJsonIfPresent(lockPath);
        if (attempt === 0 && Number.isSafeInteger(owner?.ownerPid)
          && owner.ownerPid > 0 && !this.isProcessAlive(owner.ownerPid)) {
          try { fs.unlinkSync(lockPath); } catch (unlinkError) {
            if (unlinkError.code !== 'ENOENT') throw unlinkError;
          }
          continue;
        }
        throw new DeliveryOutboxLockedError(lockId);
      }
    }
    try {
      return operation();
    } finally {
      if (lockHandle !== null) fs.closeSync(lockHandle);
      try { fs.unlinkSync(lockPath); } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
  }
}
