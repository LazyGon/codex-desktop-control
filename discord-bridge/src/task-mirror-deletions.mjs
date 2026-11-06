import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteJson } from './util.mjs';
import { taskIdFromTopic } from './task-routing.mjs';

const taskId = /^[A-Za-z0-9_-]{8,100}$/;
const channelId = /^\d+$/;
const absentChannel = error => error?.status === 404 && Number(error.code) === 10003;

export function missingDeletedThread(error, id) {
  const prefix = 'thread/read: ';
  if (!error?.message?.startsWith(prefix)) return false;
  try {
    const data = JSON.parse(error.message.slice(prefix.length));
    return data.code === -32600 && data.message === `thread not loaded: ${id}`;
  } catch { return false; }
}

// One Bridge owns its local state. Persist the exact target before presentation
// work, and persist a write fence before crossing the Discord boundary.
export class TaskMirrorDeletions {
  constructor(directory, guildId) {
    this.directory = directory;
    this.guildId = guildId;
    this.records = new Map();
    fs.mkdirSync(directory, { recursive: true });
    for (const name of fs.readdirSync(directory)) {
      const id = name.slice(0, -5);
      if (!name.endsWith('.json') || !taskId.test(id)) continue;
      const value = JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'));
      if (value.threadId !== id || value.guildId !== guildId || value.schemaVersion !== 1 ||
        !['pending', 'dispatching', 'absent', 'settled'].includes(value.phase) ||
        (value.channelId !== null && !channelId.test(value.channelId)) ||
        (value.categoryId !== null && !channelId.test(value.categoryId))) {
        throw new Error('Invalid task mirror deletion receipt.');
      }
      this.records.set(id, value);
    }
  }

  #save(value) {
    atomicWriteJson(path.join(this.directory, `${value.threadId}.json`), value, { flush: true });
    this.records.set(value.threadId, value);
    return value;
  }

  observe(id, binding, evidence = 'thread/deleted') {
    if (typeof id !== 'string' || !taskId.test(id) || (binding?.channelId && !channelId.test(binding.channelId)) ||
      (binding?.categoryId && !channelId.test(binding.categoryId))) return;
    const existing = this.records.get(id);
    if (existing && (existing.channelId || existing.phase !== 'pending' || !binding?.channelId)) return existing;
    return this.#save({ schemaVersion: 1, threadId: id, guildId: this.guildId,
      evidence: existing?.evidence ?? evidence, observedAt: existing?.observedAt ?? new Date().toISOString(),
      channelId: binding?.channelId ?? null, categoryId: binding?.categoryId ?? null, phase: 'pending' });
  }

  has(id) { return this.records.has(id); }

  pending() {
    return [...this.records.values()].filter(r => r.channelId && r.phase !== 'settled');
  }

  async reconcile(id, { readChannel, deleteChannel, canDelete, finish }) {
    let entry = this.records.get(id);
    if (!entry?.channelId || entry.phase === 'settled') return 'skipped';
    if (entry.phase !== 'absent') {
      let channel, absent = false;
      try { channel = await readChannel(entry.channelId); }
      catch (error) { if (!absentChannel(error)) throw error; absent = true; }
      if (channel) {
        if (entry.phase === 'dispatching') return 'unknown-preserved';
        const taskLines = String(channel.topic ?? '').split(/\r?\n/).filter(line => line.startsWith('Codex task:'));
        if (channel.id !== entry.channelId || channel.guild_id !== entry.guildId || channel.type !== 0 ||
          taskLines.length !== 1 || taskIdFromTopic(channel) !== id ||
          taskLines[0].slice('Codex task:'.length).trim() !== id ||
          (entry.categoryId && channel.parent_id !== entry.categoryId)) return 'identity-mismatch';
        if (!await canDelete(entry)) return 'task-not-verified-deleted';
        entry = this.#save({ ...entry, phase: 'dispatching', dispatchedAt: new Date().toISOString() });
        try { await deleteChannel(entry.channelId); }
        catch (error) { if (!absentChannel(error)) throw error; }
      } else if (!absent) {
        // An empty lookup result is not an authoritative Discord 404.
        return 'lookup-unavailable';
      } else if (!await canDelete(entry)) {
        return 'task-not-verified-deleted';
      }
      entry = this.#save({ ...entry, phase: 'absent', absentAt: new Date().toISOString() });
    }
    await finish(entry);
    this.#save({ ...entry, phase: 'settled', settledAt: new Date().toISOString() });
    return 'settled';
  }
}
