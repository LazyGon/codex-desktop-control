import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sessions = path.join(os.homedir(), '.codex', 'sessions');
const paths = new Map();
function findRollout(threadId, directory) {
  const key = directory + '|' + threadId;
  if (paths.has(key)) return paths.get(key);
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).reverse()) {
    const file = path.join(directory, entry.name);
    if (entry.isFile() && entry.name.endsWith('-' + threadId + '.jsonl')) { paths.set(key, file); return file; }
    if (entry.isDirectory()) {
      const found = findRollout(threadId, file);
      if (found) { paths.set(key, found); return found; }
    }
  }
  return null;
}

// Absence is not a terminal outcome. Read complete lines, including old turns
// outside a fixed tail window; a concurrently appended partial line is retried.
export function rolloutTurn(threadId, turnId = null, { file, sessionsDirectory = sessions } = {}) {
  if (!threadId) return null;
  let fd;
  try {
    file ??= findRollout(threadId, sessionsDirectory);
    if (!file) return null;
    fd = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(64 * 1024);
    let pending = '', count, outcome = null;
    const decoder = new TextDecoder();
    while ((count = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      const lines = (pending + decoder.decode(buffer.subarray(0, count), { stream: true })).split('\n');
      pending = lines.pop();
      for (const line of lines) {
        if (turnId && !line.includes(turnId)) continue;
        let event;
        try { event = JSON.parse(line); } catch { continue; }
        const p = event.payload;
        if (event.type === 'event_msg' && p?.turn_id && (!turnId || p.turn_id === turnId) && ['task_started', 'task_complete', 'turn_aborted'].includes(p.type)) {
          outcome = { id: p.turn_id, type: p.type, status: p.type === 'task_started' ? 'inProgress' : p.type === 'task_complete' ? 'completed' : 'interrupted', answer: p.last_agent_message ?? '' };
        }
      }
    }
    return outcome;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

export function rolloutOutcome(threadId, turnId, options) {
  if (!turnId) return null;
  const turn = rolloutTurn(threadId, turnId, options);
  return turn && turn.type !== 'task_started' ? { type: turn.type, answer: turn.answer } : null;
}
