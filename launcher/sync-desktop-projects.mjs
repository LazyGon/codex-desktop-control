import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { AppServerClient } from '../discord-bridge/src/app-server-client.mjs';

function parseArguments(argv) {
  const options = {
    dryRun: false,
    endpoint: null,
    globalStatePath: null,
    bridgeStatePath: null,
    resultPath: null,
    backupDirectory: null,
    verifyThreadId: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--dry-run') {
      options.dryRun = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value) throw new Error(`Missing value for ${argument}.`);
    index += 1;
    if (argument === '--endpoint') options.endpoint = value;
    else if (argument === '--global-state') options.globalStatePath = value;
    else if (argument === '--bridge-state') options.bridgeStatePath = value;
    else if (argument === '--result') options.resultPath = value;
    else if (argument === '--backup-directory') options.backupDirectory = value;
    else if (argument === '--verify-thread') options.verifyThreadId = value;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  for (const [name, value] of Object.entries({
    endpoint: options.endpoint,
    globalState: options.globalStatePath,
    bridgeState: options.bridgeStatePath,
  })) {
    if (!value) throw new Error(`Required option is missing: ${name}`);
  }
  return options;
}

function normalizeLocalPath(input) {
  if (typeof input !== 'string' || !input.trim()) return null;
  const normalized = path.win32.normalize(input.trim());
  const root = path.win32.parse(normalized).root;
  return normalized.length > root.length
    ? normalized.replace(/[\\/]+$/, '')
    : normalized;
}

function localPathKey(input) {
  return normalizeLocalPath(input)?.toLocaleLowerCase('en-US') ?? null;
}

function arrayValue(value) {
  return Array.isArray(value) ? value : [];
}

function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function appendUniquePath(values, candidate) {
  const key = localPathKey(candidate);
  if (!key || values.some((value) => localPathKey(value) === key)) return false;
  values.push(candidate);
  return true;
}

function appendUniqueValue(values, candidate) {
  if (values.includes(candidate)) return false;
  values.push(candidate);
  return true;
}

function defaultProjectId() {
  return `local-${crypto.randomBytes(16).toString('hex')}`;
}

function defaultProjectName(rootPath) {
  return path.win32.basename(rootPath) || rootPath;
}

function projectRoot(project) {
  const roots = arrayValue(project?.rootPaths);
  return roots.length === 1 ? normalizeLocalPath(roots[0]) : null;
}

function verifiedThreadAssignment(state, threadId) {
  if (!threadId) return null;
  const assignment = objectValue(state['thread-project-assignments'])[threadId];
  if (assignment?.projectKind !== 'local' || typeof assignment.projectId !== 'string') {
    throw new Error(`Target task has no local project assignment: ${threadId}`);
  }
  const project = objectValue(state['local-projects'])[assignment.projectId];
  const cwd = normalizeLocalPath(assignment.cwd);
  const roots = arrayValue(project?.rootPaths).map(normalizeLocalPath);
  if (!cwd || !roots.some((rootPath) => localPathKey(rootPath) === localPathKey(cwd))) {
    throw new Error(`Target task project record is inconsistent: ${threadId}`);
  }
  return {
    threadId,
    projectId: assignment.projectId,
    projectName: project.name,
    cwd,
  };
}

export function reconcileDesktopProjectState(
  originalState,
  {
    projectRoots,
    threads,
    now = Date.now(),
    createProjectId = defaultProjectId,
  },
) {
  const state = structuredClone(objectValue(originalState));
  state['electron-saved-workspace-roots'] = arrayValue(state['electron-saved-workspace-roots']);
  state['project-order'] = arrayValue(state['project-order']);
  state['pinned-project-ids'] = arrayValue(state['pinned-project-ids']);
  state['local-projects'] = objectValue(state['local-projects']);
  state['thread-project-assignments'] = objectValue(state['thread-project-assignments']);

  const rootsByKey = new Map();
  for (const value of projectRoots ?? []) {
    const rootPath = normalizeLocalPath(value);
    const key = localPathKey(rootPath);
    if (key && !rootsByKey.has(key)) rootsByKey.set(key, rootPath);
  }

  const projectsByRoot = new Map();
  for (const [projectId, project] of Object.entries(state['local-projects'])) {
    const rootPath = projectRoot(project);
    const key = localPathKey(rootPath);
    if (key && !projectsByRoot.has(key)) projectsByRoot.set(key, { projectId, project });
  }

  const stats = {
    projectsConsidered: rootsByKey.size,
    projectsCreated: 0,
    savedRootsAdded: 0,
    projectOrderAdded: 0,
    pinnedProjectsAdded: 0,
    assignmentsCreated: 0,
    assignmentsUpdated: 0,
    assignmentsUnchanged: 0,
    assignmentsSkipped: 0,
  };

  for (const [key, rootPath] of rootsByKey) {
    let entry = projectsByRoot.get(key);
    if (!entry) {
      const projectId = createProjectId();
      const project = {
        id: projectId,
        name: defaultProjectName(rootPath),
        rootPaths: [rootPath],
        createdAt: now,
        updatedAt: now,
      };
      state['local-projects'][projectId] = project;
      entry = { projectId, project };
      projectsByRoot.set(key, entry);
      stats.projectsCreated += 1;
    }

    if (appendUniquePath(state['electron-saved-workspace-roots'], rootPath)) {
      stats.savedRootsAdded += 1;
    }
    if (appendUniqueValue(state['project-order'], entry.projectId)) {
      stats.projectOrderAdded += 1;
    }
    if (appendUniqueValue(state['pinned-project-ids'], entry.projectId)) {
      stats.pinnedProjectsAdded += 1;
    }
  }

  const threadsById = new Map();
  for (const thread of threads ?? []) {
    if (typeof thread?.id === 'string' && thread.id) threadsById.set(thread.id, thread);
  }
  for (const thread of threadsById.values()) {
    const cwd = normalizeLocalPath(thread.cwd);
    const entry = projectsByRoot.get(localPathKey(cwd));
    if (!cwd || !entry) {
      stats.assignmentsSkipped += 1;
      continue;
    }

    const existing = state['thread-project-assignments'][thread.id];
    if (existing?.projectKind && existing.projectKind !== 'local') {
      stats.assignmentsSkipped += 1;
      continue;
    }
    const next = {
      ...objectValue(existing),
      projectKind: 'local',
      projectId: entry.projectId,
      cwd,
      pendingCoreUpdate: existing?.pendingCoreUpdate ?? false,
    };
    const unchanged = existing
      && existing.projectKind === next.projectKind
      && existing.projectId === next.projectId
      && localPathKey(existing.cwd) === localPathKey(next.cwd)
      && existing.pendingCoreUpdate === next.pendingCoreUpdate;
    if (unchanged) {
      stats.assignmentsUnchanged += 1;
      continue;
    }
    state['thread-project-assignments'][thread.id] = next;
    if (existing) stats.assignmentsUpdated += 1;
    else stats.assignmentsCreated += 1;
  }

  return { state, stats };
}

async function listAllThreads(client, archived) {
  const threads = [];
  const cursors = new Set();
  let cursor = null;
  do {
    const params = {
      limit: 100,
      archived,
      sortKey: 'recency_at',
      sortDirection: 'desc',
    };
    if (cursor) params.cursor = cursor;
    const result = await client.call('thread/list', params, 60_000);
    threads.push(...arrayValue(result?.data));
    cursor = result?.nextCursor ?? null;
    if (cursor && cursors.has(cursor)) throw new Error(`thread/list repeated cursor: ${cursor}`);
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return threads;
}

function loadBridgeProjects(bridgeStatePath) {
  const bridgeState = JSON.parse(fs.readFileSync(bridgeStatePath, 'utf8'));
  const projectRoots = [];
  for (const project of Object.values(objectValue(bridgeState.projectCategories))) {
    const rootPath = normalizeLocalPath(project?.path);
    if (rootPath && fs.statSync(rootPath, { throwIfNoEntry: false })?.isDirectory()) {
      projectRoots.push(rootPath);
    }
  }
  const boundThreads = [];
  for (const [threadId, binding] of Object.entries(objectValue(bridgeState.bindings))) {
    if (typeof binding?.cwd === 'string') boundThreads.push({ id: threadId, cwd: binding.cwd });
  }
  return { projectRoots, boundThreads };
}

function timestampForPath(date = new Date()) {
  return date.toISOString().replaceAll(':', '').replaceAll('-', '').replace(/\.\d{3}Z$/, 'Z');
}

function atomicWriteJson(targetPath, value) {
  const temporaryPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(value), { encoding: 'utf8', flag: 'wx' });
  try {
    fs.renameSync(temporaryPath, targetPath);
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
}

function writeResult(resultPath, result) {
  if (!resultPath) return;
  fs.mkdirSync(path.dirname(resultPath), { recursive: true });
  atomicWriteJson(resultPath, result);
}

async function run() {
  const options = parseArguments(process.argv.slice(2));
  const globalStatePath = path.resolve(options.globalStatePath);
  const bridgeStatePath = path.resolve(options.bridgeStatePath);
  if (!fs.existsSync(globalStatePath)) throw new Error(`Desktop state is missing: ${globalStatePath}`);
  if (!fs.existsSync(bridgeStatePath)) throw new Error(`Bridge state is missing: ${bridgeStatePath}`);

  const { projectRoots, boundThreads } = loadBridgeProjects(bridgeStatePath);
  const client = new AppServerClient(options.endpoint);
  let activeThreads;
  let archivedThreads;
  try {
    await client.connect();
    [activeThreads, archivedThreads] = await Promise.all([
      listAllThreads(client, false),
      listAllThreads(client, true),
    ]);
  } finally {
    client.close();
  }

  const originalText = fs.readFileSync(globalStatePath, 'utf8');
  const originalState = JSON.parse(originalText);
  const { state, stats } = reconcileDesktopProjectState(originalState, {
    projectRoots,
    threads: [...activeThreads, ...archivedThreads, ...boundThreads],
  });
  const changed = JSON.stringify(state) !== JSON.stringify(originalState);
  const verifiedThread = verifiedThreadAssignment(state, options.verifyThreadId);
  let backupPath = null;
  if (changed && !options.dryRun) {
    const backupDirectory = path.resolve(
      options.backupDirectory ?? path.join(path.dirname(globalStatePath), 'desktop-project-sync-backups'),
    );
    fs.mkdirSync(backupDirectory, { recursive: true });
    backupPath = path.join(
      backupDirectory,
      `${path.basename(globalStatePath)}.${timestampForPath()}.bak`,
    );
    fs.copyFileSync(globalStatePath, backupPath, fs.constants.COPYFILE_EXCL);
    atomicWriteJson(globalStatePath, state);
    JSON.parse(fs.readFileSync(globalStatePath, 'utf8'));
  }

  const result = {
    ok: true,
    dryRun: options.dryRun,
    changed,
    endpoint: options.endpoint,
    activeThreads: activeThreads.length,
    archivedThreads: archivedThreads.length,
    bridgeProjects: projectRoots.length,
    backupPath,
    stats,
    verifiedThread,
    completedAt: new Date().toISOString(),
  };
  writeResult(options.resultPath, result);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  run().catch((error) => {
    const resultPathIndex = process.argv.indexOf('--result');
    const resultPath = resultPathIndex >= 0 ? process.argv[resultPathIndex + 1] : null;
    const result = {
      ok: false,
      error: error.message,
      completedAt: new Date().toISOString(),
    };
    try {
      writeResult(resultPath, result);
    } catch {
      // Preserve the original failure.
    }
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
