import fs from 'node:fs';
import path from 'node:path';
import {
  isPathWithinProject,
  normalizeProjectPath,
  projectDescriptor,
  projectPathKey,
  truncate,
} from './util.mjs';

function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function arrayValue(value) {
  return Array.isArray(value) ? value : [];
}

function projectPathKeyIfValid(value) {
  try {
    return projectPathKey(value);
  } catch {
    return null;
  }
}

function normalizedProjectPathIfValid(value) {
  try {
    return normalizeProjectPath(value);
  } catch {
    return null;
  }
}

function localProjectRecord(projectId, value) {
  const roots = new Map();
  for (const rootPath of arrayValue(value?.rootPaths)) {
    const normalized = normalizedProjectPathIfValid(rootPath);
    const key = projectPathKeyIfValid(normalized);
    if (key && !roots.has(key)) roots.set(key, normalized);
  }
  const rootPaths = [...roots.values()];
  const configuredName = typeof value?.name === 'string' ? value.name.trim() : '';
  return {
    projectId,
    name: configuredName || path.win32.basename(rootPaths[0] ?? '') || projectId,
    rootPaths,
  };
}

function appServerProjectRecord(value) {
  const projectId = typeof value?.id === 'string' ? value.id.trim() : '';
  if (!projectId) return null;
  const roots = new Map();
  for (const root of arrayValue(value?.roots)) {
    const normalized = normalizedProjectPathIfValid(root?.path);
    const key = projectPathKeyIfValid(normalized);
    if (key && !roots.has(key)) roots.set(key, normalized);
  }
  const rootPaths = [...roots.values()];
  const configuredName = typeof value?.name === 'string' ? value.name.trim() : '';
  return {
    projectId,
    name: configuredName || path.win32.basename(rootPaths[0] ?? '') || projectId,
    rootPaths,
  };
}

export function appServerProjectKey(projectId) {
  if (typeof projectId !== 'string' || !projectId.trim()) {
    throw new Error('An App Server project id is required.');
  }
  return `app-server:${projectId.trim()}`;
}

export function desktopProjectSnapshot(value, source = null) {
  const state = objectValue(value);
  const projects = new Map();
  const projectRoots = new Set();
  const roots = [];
  for (const [projectId, value] of Object.entries(objectValue(state['local-projects']))) {
    if (!projectId) continue;
    const project = localProjectRecord(projectId, value);
    projects.set(projectId, project);
    for (const rootPath of project.rootPaths) {
      const key = projectPathKey(rootPath);
      projectRoots.add(key);
      roots.push({ projectId, path: rootPath, key });
    }
  }
  roots.sort((left, right) => right.key.length - left.key.length
    || left.projectId.localeCompare(right.projectId));
  return {
    available: true,
    source,
    projects,
    projectRoots,
    roots,
    assignments: new Map(Object.entries(objectValue(state['thread-project-assignments']))),
  };
}

export function readDesktopProjectSnapshot(statePath) {
  const source = statePath ? path.resolve(statePath) : null;
  if (!source) {
    return {
      available: false,
      source: null,
      projects: new Map(),
      projectRoots: new Set(),
      roots: [],
      assignments: new Map(),
      error: 'Desktop global state path is not configured.',
    };
  }
  try {
    return desktopProjectSnapshot(
      JSON.parse(fs.readFileSync(source, 'utf8')),
      source,
    );
  } catch (error) {
    return {
      available: false,
      source,
      projects: new Map(),
      projectRoots: new Set(),
      roots: [],
      assignments: new Map(),
      error: error.message,
    };
  }
}

export function withAppServerProjects(snapshot, values) {
  const projects = new Map();
  for (const value of arrayValue(values)) {
    const project = appServerProjectRecord(value);
    if (project) projects.set(project.projectId, project);
  }
  return {
    ...snapshot,
    appServerProjectsAvailable: true,
    appServerProjects: projects,
  };
}

export function appServerProjectForThread(thread, snapshot) {
  const projectId = typeof thread?.projectId === 'string' ? thread.projectId.trim() : '';
  const project = projectId ? snapshot?.appServerProjects?.get(projectId) : null;
  return project ? { ...project, resolution: 'app-server-project-id', matchedRootPath: null } : null;
}

export function desktopProjectForThread(thread, snapshot) {
  if (!snapshot?.available) return null;
  const assignment = snapshot.assignments?.get(thread?.id);
  const assignedProjectId = typeof assignment?.projectId === 'string'
    ? assignment.projectId
    : null;
  const assigned = assignedProjectId ? snapshot.projects?.get(assignedProjectId) : null;
  if (assigned) return { ...assigned, resolution: 'assignment', matchedRootPath: null };

  const cwd = normalizedProjectPathIfValid(thread?.cwd);
  if (!cwd) return null;
  const match = (snapshot.roots ?? [])
    .find((candidate) => isPathWithinProject(cwd, candidate.path));
  if (!match) return null;
  const project = snapshot.projects.get(match.projectId);
  return project
    ? { ...project, resolution: 'root', matchedRootPath: match.path }
    : null;
}

export function projectForThread(thread, snapshot) {
  return appServerProjectForThread(thread, snapshot)
    ?? desktopProjectForThread(thread, snapshot);
}

export function projectCwdForThread(thread, snapshot) {
  const nativeProject = appServerProjectForThread(thread, snapshot);
  if (nativeProject) return thread?.cwd ?? nativeProject.rootPaths[0] ?? null;
  if (!snapshot?.available) return thread?.cwd ?? null;
  const project = desktopProjectForThread(thread, snapshot);
  return project ? (thread?.cwd ?? project.rootPaths[0] ?? null) : null;
}

export function projectDescriptorForThread(thread, snapshot, categoryPrefix = 'Codex - ') {
  const nativeProject = appServerProjectForThread(thread, snapshot);
  if (nativeProject) {
    const descriptor = projectDescriptor(nativeProject.rootPaths[0] ?? thread?.cwd, categoryPrefix);
    return {
      ...descriptor,
      id: nativeProject.projectId,
      key: appServerProjectKey(nativeProject.projectId),
      name: truncate(`${categoryPrefix}${nativeProject.name}`, 100, ''),
    };
  }
  if (!snapshot?.available) return projectDescriptor(thread?.cwd, categoryPrefix);
  const project = desktopProjectForThread(thread, snapshot);
  if (!project) return projectDescriptor(null, categoryPrefix);
  const descriptor = projectDescriptor(project.rootPaths[0] ?? thread?.cwd, categoryPrefix);
  return {
    ...descriptor,
    id: project.projectId,
    key: project.projectId,
    name: truncate(`${categoryPrefix}${project.name}`, 100, ''),
  };
}

export function projectDescriptorsFromSnapshot(snapshot, categoryPrefix = 'Codex - ') {
  const descriptors = [];
  for (const project of snapshot?.projects?.values?.() ?? []) {
    descriptors.push({
      id: project.projectId,
      key: project.projectId,
      path: project.rootPaths[0] ?? '(no project)',
      name: truncate(`${categoryPrefix}${project.name}`, 100, ''),
    });
  }
  for (const project of snapshot?.appServerProjects?.values?.() ?? []) {
    descriptors.push({
      id: project.projectId,
      key: appServerProjectKey(project.projectId),
      path: project.rootPaths[0] ?? '(no project)',
      name: truncate(`${categoryPrefix}${project.name}`, 100, ''),
    });
  }
  return descriptors;
}
