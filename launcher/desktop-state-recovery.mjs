import fs from 'node:fs';
import path from 'node:path';

function parseState(text) {
  const value = JSON.parse(text.replace(/^\uFEFF/, ''));
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Desktop state must be an object.');
  }
  return value;
}

// Only known state backups are eligible. Never reset an unreadable state to {}.
export function readDesktopState(globalStatePath, backupDirectory) {
  const originalText = fs.readFileSync(globalStatePath, 'utf8');
  try {
    return { state: parseState(originalText), originalText, recoveredFrom: null };
  } catch {
    const candidates = [`${globalStatePath}.bak`];
    if (backupDirectory && fs.existsSync(backupDirectory)) {
      const prefix = `${path.basename(globalStatePath)}.`;
      candidates.push(...fs.readdirSync(backupDirectory)
        .filter(name => name.startsWith(prefix) && name.endsWith('.bak'))
        .map(name => path.join(backupDirectory, name)));
    }
    const available = candidates.filter(file => fs.statSync(file, { throwIfNoEntry: false })?.isFile())
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    for (const candidate of available) {
      try {
        return { state: parseState(fs.readFileSync(candidate, 'utf8')), originalText, recoveredFrom: candidate };
      } catch { /* Reject corrupt backups without printing state contents. */ }
    }
    throw new Error('Desktop state is unreadable and no valid known backup exists. Original state preserved.');
  }
}

const mapKeys = [
  'local-projects', 'thread-project-assignments', 'thread-workspace-root-hints',
  'thread-projectless-output-directories', 'sidebar-project-thread-orders',
  'project-appearances', 'thread-project-membership-host-ids',
];
const listKeys = [
  'electron-saved-workspace-roots', 'project-order', 'pinned-project-ids',
  'projectless-thread-ids',
];
const nestedMapKeys = [
  'app-server-project-id-by-legacy-project-id-by-host', 'app-server-projects-migration-by-host',
];
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const array = value => Array.isArray(value) ? value : [];
const union = (current, previous) => [...new Set([...array(current), ...array(previous)])];

// Explicit repair only: merge project metadata, not accounts, feature flags,
// queued messages, permissions, remote-control identity or task contents.
export function recoverDesktopProjects(current, backup) {
  if (Object.keys(object(backup['local-projects'])).length === 0) {
    throw new Error('The selected backup contains no local projects.');
  }
  const state = structuredClone(current);
  for (const key of mapKeys) {
    state[key] = { ...structuredClone(object(backup[key])), ...object(state[key]) };
  }
  for (const key of listKeys) state[key] = union(state[key], backup[key]);
  for (const key of nestedMapKeys) {
    const merged = structuredClone(object(backup[key]));
    for (const [host, value] of Object.entries(object(state[key]))) {
      merged[host] = { ...object(merged[host]), ...object(value) };
    }
    state[key] = merged;
  }
  for (const key of ['active-workspace-roots', 'selected-project']) {
    if (!Object.hasOwn(state, key) && Object.hasOwn(backup, key)) state[key] = structuredClone(backup[key]);
  }
  const atoms = state['electron-persisted-atom-state'] = { ...object(state['electron-persisted-atom-state']) };
  for (const [key, value] of Object.entries(object(backup['electron-persisted-atom-state']))) {
    if (key === 'unified-sidebar-project-order-v1' || key === 'unified-sidebar-pinned-order-v1') {
      atoms[key] = union(atoms[key], value);
    } else if (key === 'flat-project-sidebar-preferences-v1') {
      atoms[key] = { ...object(value), ...object(atoms[key]), initialized: true, mode: 'project' };
    } else if (key.startsWith('sidebar-project-expanded-v1-codex:') && !Object.hasOwn(atoms, key)) {
      atoms[key] = value;
    }
  }
  return state;
}

export function readProjectRecoveryBackup(file) {
  const state = parseState(fs.readFileSync(file, 'utf8'));
  recoverDesktopProjects({}, state); // Validate eligibility before closing Desktop.
  return state;
}
