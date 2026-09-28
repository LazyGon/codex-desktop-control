import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Read lifecycle metadata only. Never return messages, prompts, tool data or secrets.
export function lifecycleFromText(text, since) {
  const turns = new Map();
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.includes('"event_msg"')) continue;
    let event;
    try { event = JSON.parse(line); } catch {
      if (index === lines.length - 1) break; // A writer may have an incomplete final line.
      throw new Error('A complete rollout line is unreadable; refusing an idle conclusion.');
    }
    if (event.type !== 'event_msg' || !event.payload?.turn_id) continue;
    if (!['task_started', 'task_complete', 'turn_aborted'].includes(event.payload.type)) continue;
    if (!Number.isFinite(Date.parse(event.timestamp))) throw new Error('Invalid lifecycle timestamp.');
    if (Date.parse(event.timestamp) < since) continue;
    turns.set(event.payload.turn_id, event.payload.type);
  }
  return turns;
}

export async function inspectPrivateTurns({ sessionsRoot, sourcePath, threadId, turnId, since }) {
  const cutoff = Date.parse(since);
  if (!Number.isFinite(cutoff)) throw new Error('Invalid lifecycle cutoff.');
  const root = path.resolve(sessionsRoot);
  const source = path.resolve(sourcePath);
  if (!source.startsWith(`${root}${path.sep}`)) throw new Error('Source rollout is outside the session directory.');
  const entries = await fs.readdir(root, { recursive: true, withFileTypes: true });
  let sourceStatus = null;
  const activeThreadIds = new Set();
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
    const filename = path.join(entry.parentPath, entry.name);
    const match = entry.name.match(/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.jsonl$/);
    if (!match) continue;
    const stat = await fs.stat(filename);
    if (stat.mtimeMs < cutoff && filename !== source) continue;
    const turns = lifecycleFromText(await fs.readFile(filename, 'utf8'), cutoff);
    if ([...turns.values()].includes('task_started')) activeThreadIds.add(match[1]);
    if (filename === source && match[1] === threadId) sourceStatus = turns.get(turnId) ?? null;
  }
  if (!sourceStatus) throw new Error('The exact source turn was not found; refusing to close Desktop.');
  return { threadId, turnId, sourceStatus, activeThreadIds: [...activeThreadIds].sort() };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const options = {};
  for (let index = 2; index < process.argv.length; index += 2) {
    const key = process.argv[index];
    const mapping = { '--sessions': 'sessionsRoot', '--source': 'sourcePath', '--thread': 'threadId', '--turn': 'turnId', '--since': 'since' };
    if (!mapping[key] || !process.argv[index + 1]) throw new Error(`Invalid option: ${key}`);
    options[mapping[key]] = process.argv[index + 1];
  }
  inspectPrivateTurns(options).then(result => process.stdout.write(`${JSON.stringify(result)}\n`)).catch(() => {
    process.stderr.write('Private turn lifecycle inspection failed; no idle conclusion is safe.\n');
    process.exitCode = 1;
  });
}
