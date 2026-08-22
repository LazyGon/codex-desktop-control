import fs from 'node:fs';
import path from 'node:path';
import { projectDescriptor, projectPathKey } from './util.mjs';

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

export function desktopProjectSnapshot(value, source = null) {
  const state = objectValue(value);
  const projectRoots = new Set();
  for (const project of Object.values(objectValue(state['local-projects']))) {
    for (const rootPath of arrayValue(project?.rootPaths)) {
      const key = projectPathKeyIfValid(rootPath);
      if (key) projectRoots.add(key);
    }
  }
  return {
    available: true,
    source,
    projectRoots,
    assignments: new Map(Object.entries(objectValue(state['thread-project-assignments']))),
  };
}

export function readDesktopProjectSnapshot(statePath) {
  const source = statePath ? path.resolve(statePath) : null;
  if (!source) {
    return {
      available: false,
      source: null,
      projectRoots: new Set(),
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
      projectRoots: new Set(),
      assignments: new Map(),
      error: error.message,
    };
  }
}

export function projectCwdForThread(thread, snapshot) {
  if (!thread?.cwd) return null;
  if (!snapshot?.available) return thread.cwd;

  if (snapshot.assignments.has(thread.id)) return thread.cwd;
  const cwdKey = projectPathKeyIfValid(thread.cwd);
  return cwdKey && snapshot.projectRoots.has(cwdKey) ? thread.cwd : null;
}

export function projectDescriptorForThread(thread, snapshot, categoryPrefix = 'Codex - ') {
  return projectDescriptor(projectCwdForThread(thread, snapshot), categoryPrefix);
}
