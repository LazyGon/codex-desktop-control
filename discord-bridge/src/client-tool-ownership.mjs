import { readJsonIfPresent } from './util.mjs';

const READ_ONLY_CODEX_APP_TOOLS = new Set([
  'list_projects',
  'list_threads',
  'load_workspace_dependencies',
  'read_thread',
]);

export function requiresExclusiveClientToolOwner(namespace, tool) {
  return namespace === 'codex_app' && !READ_ONLY_CODEX_APP_TOOLS.has(tool);
}

function normalizedEndpoint(value) {
  try {
    const url = new URL(value);
    if (!['ws:', 'wss:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      || url.username || url.password || url.search || url.hash) return null;
    const host = url.hostname.toLocaleLowerCase('en-US') === 'localhost'
      ? '127.0.0.1'
      : url.hostname.toLocaleLowerCase('en-US');
    return `${url.protocol}//${host}:${url.port}${url.pathname.replace(/\/$/, '')}`;
  } catch {
    return null;
  }
}

export function processIsAlive(processId) {
  if (!Number.isSafeInteger(processId) || processId <= 0) return false;
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    return error?.code === 'EPERM' ? true : null;
  }
}

export function sharedServerAvailable(owner, generation = owner?.generation) {
  return Boolean(generation && owner?.generation === generation
    && (owner.state === 'present' || owner.state === 'absent'));
}

export function inspectDesktopClientOwner({
  launcherStatePath,
  appServerUrl,
  isProcessAlive = processIsAlive,
}) {
  let state;
  try { state = readJsonIfPresent(launcherStatePath); }
  catch { return { state: 'ambiguous', generation: null, reason: 'launcher-state-unavailable' }; }
  if (!state) return { state: 'ambiguous', generation: null, reason: 'launcher-state-unavailable' };
  if (!['desktop', 'server'].includes(state.mode)) {
    return { state: 'ambiguous', generation: null, reason: 'launcher-mode-unverified' };
  }

  const stateEndpoint = normalizedEndpoint(state.websocketUrl);
  const activeEndpoint = normalizedEndpoint(appServerUrl);
  if (!stateEndpoint || !activeEndpoint || stateEndpoint !== activeEndpoint) {
    return { state: 'ambiguous', generation: null, reason: 'app-server-endpoint-mismatch' };
  }
  const alive = (pid) => {
    try { return isProcessAlive(pid); } catch { return null; }
  };
  if (!Number.isSafeInteger(state.serverProcessId) || state.serverProcessId <= 0
    || alive(state.serverProcessId) !== true || typeof state.startedAt !== 'string'
    || !Number.isFinite(Date.parse(state.startedAt))) {
    return { state: 'ambiguous', generation: null, reason: 'app-server-generation-unverified' };
  }

  const generation = [stateEndpoint, state.serverProcessId, state.startedAt].join('|');
  if (!Array.isArray(state.desktopProcessIds)
    || state.desktopProcessIds.some((pid) => !Number.isSafeInteger(pid) || pid <= 0)) {
    return { state: 'ambiguous', generation, reason: 'desktop-process-list-unavailable' };
  }
  const desktopProcesses = state.desktopProcessIds.map(alive);
  const desktopAlive = desktopProcesses.includes(true);
  if (desktopAlive && state.mode === 'desktop' && state.desktopConnectionVerified === true) {
    return { state: 'present', generation, reason: 'verified-desktop-process-alive' };
  }
  if (desktopProcesses.every((result) => result === false)) {
    return { state: 'absent', generation, reason: 'no-desktop-process-alive' };
  }
  return { state: 'ambiguous', generation, reason: 'desktop-connection-unverified' };
}

export function clientToolRequestKey(generation, requestId) {
  return `${generation}|request:${String(requestId)}`;
}
