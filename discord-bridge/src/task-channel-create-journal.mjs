import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicWriteJson } from './util.mjs';

const taskIdPattern = /^[A-Za-z0-9_-]{8,100}$/;
const snowflakePattern = /^\d+$/;

export class TaskChannelCreateJournal {
  constructor(directory) {
    this.directory = directory;
    this.pending = new Map();
    fs.mkdirSync(directory, { recursive: true });
  }

  recordPath(threadId) {
    if (!taskIdPattern.test(threadId)) throw new Error('INVALID_CHANNEL_CREATE_TASK_ID');
    return path.join(this.directory, `${threadId}.json`);
  }

  read(threadId) {
    try {
      const record = JSON.parse(fs.readFileSync(this.recordPath(threadId), 'utf8'));
      if (record.schemaVersion !== 1 || record.threadId !== threadId) throw new Error('INVALID_CHANNEL_CREATE_RECORD');
      return record;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  #persist(record) {
    const event = { ...record, updatedAt: new Date().toISOString(), revisionId: randomUUID() };
    fs.writeFileSync(path.join(this.directory, `${record.threadId}.${event.revisionId}.event.json`),
      `${JSON.stringify(event, null, 2)}\n`, { flag: 'wx' });
    atomicWriteJson(this.recordPath(record.threadId), event);
    return event;
  }

  #scope(scope) {
    if (!taskIdPattern.test(scope.threadId) || !snowflakePattern.test(scope.guildId)
      || !snowflakePattern.test(scope.categoryId)) throw new Error('INVALID_CHANNEL_CREATE_SCOPE');
  }

  importUnknown(scope, evidence) {
    this.#scope(scope);
    if (this.read(scope.threadId)) throw new Error('CHANNEL_CREATE_RECORD_ALREADY_EXISTS');
    return this.#persist({ schemaVersion: 1, ...scope, attemptId: randomUUID(), phase: 'unknown',
      imported: true, evidence, startedAt: new Date().toISOString() });
  }

  reconcileAbsent(threadId, proof) {
    const current = this.read(threadId);
    if (!current || !['unknown', 'dispatching'].includes(current.phase)
      || proof.actorExited !== true || proof.matchingChannelCount !== 0
      || !proof.authorizationRef || !proof.channelReadEvidenceSha256 || !proof.closedActorEvidenceSha256) {
      throw new Error('CHANNEL_CREATE_RECONCILIATION_REQUIRED');
    }
    // This is a forward recovery decision, not a claim that the old request did
    // not execute. Preserve its unknown result in the immutable event history.
    return this.#persist({ ...current, phase: 'reconciledAbsent', recoveryProof: proof });
  }

  async create(scope, operation) {
    this.#scope(scope);
    const inFlight = this.pending.get(scope.threadId);
    if (inFlight) {
      if (inFlight.guildId !== scope.guildId || inFlight.categoryId !== scope.categoryId) {
        throw new Error('CHANNEL_CREATE_SCOPE_CONFLICT');
      }
      return inFlight.promise;
    }
    const promise = this.#createOnce(scope, operation);
    this.pending.set(scope.threadId, { ...scope, promise });
    try { return await promise; }
    finally { this.pending.delete(scope.threadId); }
  }

  async #createOnce(scope, operation) {
    const lockPath = `${this.recordPath(scope.threadId)}.lock`;
    let lock;
    try { lock = fs.openSync(lockPath, 'wx'); }
    catch { throw new Error('CHANNEL_CREATE_LOCKED'); }
    try {
      const prior = this.read(scope.threadId);
      if (prior && (prior.guildId !== scope.guildId || prior.categoryId !== scope.categoryId
        || prior.phase !== 'reconciledAbsent')) throw new Error('CHANNEL_CREATE_RESULT_UNRESOLVED');
      let record = this.#persist({ schemaVersion: 1, ...scope, attemptId: randomUUID(),
        previousAttemptId: prior?.attemptId ?? null, phase: 'dispatching',
        startedAt: new Date().toISOString(), processId: process.pid });
      try {
        const channel = await operation();
        if (!channel?.id) throw new Error('CHANNEL_CREATE_MISSING_ID');
        record = this.#persist({ ...record, phase: 'confirmed', channelId: channel.id });
        return channel;
      } catch (error) {
        this.#persist({ ...record, phase: 'unknown',
          ...(Number.isInteger(error.status) ? { httpStatus: error.status } : {}),
          ...(Number.isInteger(error.code) ? { discordErrorCode: error.code } : {}) });
        throw new Error('CHANNEL_CREATE_RESULT_UNKNOWN');
      }
    } finally {
      fs.closeSync(lock);
      fs.unlinkSync(lockPath);
    }
  }
}
