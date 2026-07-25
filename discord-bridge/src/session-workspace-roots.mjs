import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { normalizeLocalTarget } from './local-file-share.mjs';

function normalizedRoots(values) {
  const roots = new Map();
  for (const value of Array.isArray(values) ? values : []) {
    const rootPath = normalizeLocalTarget(typeof value === 'string' ? value : value?.path);
    if (!rootPath) continue;
    const parsedRoot = path.win32.parse(rootPath).root;
    const normalized = rootPath.length > parsedRoot.length
      ? rootPath.replace(/[\\/]+$/, '')
      : rootPath;
    const key = normalized.toLocaleLowerCase('en-US');
    if (!roots.has(key)) roots.set(key, normalized);
  }
  return [...roots.values()];
}

export async function readSessionWorkspaceRoots(sessionPath, threadId) {
  if (!sessionPath || !threadId) return [];
  let sessionId = null;
  let latestRoots = [];
  let stream;
  try {
    stream = fs.createReadStream(sessionPath, { encoding: 'utf8' });
    const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of lines) {
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (entry?.type === 'session_meta') {
        sessionId = entry.payload?.id ?? entry.payload?.session_id ?? sessionId;
      } else if (entry?.type === 'turn_context') {
        latestRoots = normalizedRoots(
          entry.payload?.workspace_roots
            ?? entry.payload?.workspaceRoots
            ?? entry.payload?.workspace?.roots,
        );
      }
    }
  } catch {
    stream?.destroy();
    return [];
  }
  return sessionId === threadId ? latestRoots : [];
}

function isSafeThreadPathSegment(threadId) {
  return typeof threadId === 'string'
    && /^[0-9A-Za-z][0-9A-Za-z_-]{0,127}$/.test(threadId);
}

export function isTaskScopedCodexArtifactRoot(rootPath, threadId, codexHomePath) {
  const root = normalizeLocalTarget(rootPath);
  const codexHome = normalizeLocalTarget(codexHomePath);
  if (!root || !isSafeThreadPathSegment(threadId) || !codexHome) return false;
  const normalizedThreadId = threadId.toLocaleLowerCase('en-US');
  const generatedImages = path.win32.join(codexHome, 'generated_images');
  const generatedRelative = path.win32.relative(generatedImages, root);
  if (generatedRelative
    && !generatedRelative.startsWith('..')
    && !path.win32.isAbsolute(generatedRelative)
    && !generatedRelative.includes('\\')
    && generatedRelative.toLocaleLowerCase('en-US') === normalizedThreadId) {
    return true;
  }
  const visualizations = path.win32.join(codexHome, 'visualizations');
  const relative = path.win32.relative(visualizations, root);
  if (!relative || relative.startsWith('..') || path.win32.isAbsolute(relative)) return false;
  const segments = relative.split('\\');
  return segments.length === 4
    && /^\d{4}$/.test(segments[0])
    && /^(?:0[1-9]|1[0-2])$/.test(segments[1])
    && /^(?:0[1-9]|[12]\d|3[01])$/.test(segments[2])
    && segments[3].toLocaleLowerCase('en-US') === normalizedThreadId;
}
