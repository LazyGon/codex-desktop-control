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
    return error?.code === 'EPERM';
  }
}

export function inspectDesktopClientOwner({
  launcherStatePath,
  appServerUrl,
  isProcessAlive = processIsAlive,
}) {
  const state = readJsonIfPresent(launcherStatePath);
  if (!state) return { state: 'ambiguous', generation: null, reason: 'launcher-state-unavailable' };

  const stateEndpoint = normalizedEndpoint(state.websocketUrl);
  const activeEndpoint = normalizedEndpoint(appServerUrl);
  if (!stateEndpoint || !activeEndpoint || stateEndpoint !== activeEndpoint) {
    return { state: 'ambiguous', generation: null, reason: 'app-server-endpoint-mismatch' };
  }
  if (!Number.isSafeInteger(state.serverProcessId) || !isProcessAlive(state.serverProcessId)) {
    return { state: 'ambiguous', generation: null, reason: 'app-server-generation-unverified' };
  }

  const generation = [stateEndpoint, state.serverProcessId, state.startedAt ?? 'unknown-start'].join('|');
  if (!Array.isArray(state.desktopProcessIds)) {
    return { state: 'ambiguous', generation, reason: 'desktop-process-list-unavailable' };
  }
  const desktopAlive = state.desktopProcessIds.some((processId) => isProcessAlive(processId));
  if (desktopAlive && state.mode === 'desktop' && state.desktopConnectionVerified === true) {
    return { state: 'present', generation, reason: 'verified-desktop-process-alive' };
  }
  if (!desktopAlive) {
    return { state: 'absent', generation, reason: 'no-desktop-process-alive' };
  }
  return { state: 'ambiguous', generation, reason: 'desktop-connection-unverified' };
}

export function clientToolRequestKey(generation, requestId) {
  return `${generation}|request:${String(requestId)}`;
}
