import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { AppServerClient } from '../discord-bridge/src/app-server-client.mjs';
import { atomicWriteJson } from './sync-desktop-projects.mjs';
import { readProjectRecoveryBackup } from './desktop-state-recovery.mjs';

const rootKey = value => path.win32.normalize(value.replace(/^\\\\\?\\/, '')).replace(/[\\/]+$/, '').toLowerCase();
const rootsOf = project => (project?.rootPaths ?? project?.roots?.map(root => root.path) ?? []).map(rootKey).sort();

export function resolveRecoveryProjects(backup, projects) {
  const mapping = new Map();
  for (const [legacyId, project] of Object.entries(backup['local-projects'] ?? {})) {
    const roots = rootsOf(project);
    if (roots.length === 0) continue;
    const matches = projects.filter(candidate => JSON.stringify(rootsOf(candidate)) === JSON.stringify(roots));
    if (matches.length !== 1) throw new Error(`Expected one existing AppServer project for legacy project ${legacyId}; found ${matches.length}.`);
    mapping.set(legacyId, matches[0].id);
  }
  return mapping;
}

export function planRecoveryAssignment(thread, assignment, mapping) {
  if (assignment?.projectKind !== 'local' || !mapping.has(assignment.projectId)) return null;
  const projectId = mapping.get(assignment.projectId);
  if (thread.projectId) {
    return { threadId: thread.id, projectId, beforeProjectId: thread.projectId,
      phase: thread.projectId === projectId ? 'already-correct' : 'preserved-newer-assignment' };
  }
  return { threadId: thread.id, projectId, beforeProjectId: null, phase: 'prepared' };
}

async function run() {
  const options = {};
  for (let index = 2; index < process.argv.length; index += 1) {
    const option = process.argv[index];
    if (option === '--dry-run') options.dryRun = true;
    else if (['--runtime-state', '--backup', '--result'].includes(option) && process.argv[index + 1]) options[option] = process.argv[++index];
    else throw new Error(`Invalid option: ${option}`);
  }
  const runtime = JSON.parse(fs.readFileSync(options['--runtime-state'], 'utf8'));
  if (runtime.desktopConnectionVerified !== true || runtime.websocketUrl !== `ws://127.0.0.1:${runtime.port}`) {
    throw new Error('The canonical shared runtime is not verified.');
  }
  const ready = await fetch(runtime.readyUrl, { signal: AbortSignal.timeout(5000) });
  if (!ready.ok) throw new Error('The canonical shared AppServer is not ready.');
  const backup = readProjectRecoveryBackup(options['--backup']);
  const backupSha256 = crypto.createHash('sha256').update(fs.readFileSync(options['--backup'])).digest('hex');
  const receiptPath = options['--result'];
  if (!receiptPath) throw new Error('A durable result path is required.');
  if (fs.existsSync(receiptPath)) throw new Error('This repair receipt already exists; inspect it rather than replaying writes.');
  const client = new AppServerClient(runtime.websocketUrl, { requestTimeoutMs: 60_000 });
  const receipt = { phase: 'planning', backupSha256, dryRun: Boolean(options.dryRun), entries: [], updatedAt: null };
  const save = () => {
    receipt.updatedAt = new Date().toISOString();
    fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
    atomicWriteJson(receiptPath, receipt);
  };
  try {
    await client.connect();
    const projects = [];
    let cursor = null;
    do {
      const result = await client.call('project/list', { limit: 100, ...(cursor ? { cursor } : {}) });
      projects.push(...result.data);
      cursor = result.nextCursor;
    } while (cursor);
    const mapping = resolveRecoveryProjects(backup, projects);
    for (const [threadId, assignment] of Object.entries(backup['thread-project-assignments'] ?? {})) {
      if (assignment.projectKind !== 'local' || !mapping.has(assignment.projectId)) continue;
      const { thread } = await client.call('thread/read', { threadId, includeTurns: false });
      if (thread.id !== threadId) throw new Error('AppServer returned a mismatched thread.');
      const plan = planRecoveryAssignment(thread, assignment, mapping);
      if (plan) receipt.entries.push(plan);
    }
    receipt.phase = 'prepared'; save();
    if (!options.dryRun) {
      for (const entry of receipt.entries.filter(entry => entry.phase === 'prepared')) {
        // Re-read immediately before the project-only mutation. Never start a turn
        // or override workspace, model, approval or sandbox settings.
        const { thread } = await client.call('thread/read', { threadId: entry.threadId, includeTurns: false });
        if (thread.projectId) {
          entry.phase = thread.projectId === entry.projectId ? 'already-correct' : 'preserved-newer-assignment'; save(); continue;
        }
        entry.phase = 'dispatching'; save();
        await client.call('thread/metadata/update', { threadId: entry.threadId, projectId: entry.projectId });
        const checked = await client.call('thread/read', { threadId: entry.threadId, includeTurns: false });
        if (checked.thread.projectId !== entry.projectId) throw new Error('Project assignment verification failed.');
        entry.phase = 'verified'; save();
      }
    }
    receipt.phase = options.dryRun ? 'dry-run-completed' : 'completed'; save();
    console.log(JSON.stringify({ ok: true, phase: receipt.phase,
      considered: receipt.entries.length, migrated: receipt.entries.filter(entry => entry.phase === 'verified').length,
      unchanged: receipt.entries.filter(entry => entry.phase === 'already-correct').length,
      preserved: receipt.entries.filter(entry => entry.phase === 'preserved-newer-assignment').length, receiptPath }));
  } catch (error) {
    receipt.phase = 'failed'; receipt.error = error.message; save(); throw error;
  } finally { client.close(); }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  run().catch(error => { console.error(error.message); process.exitCode = 1; });
}
