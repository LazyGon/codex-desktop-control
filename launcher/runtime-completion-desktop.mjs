import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { sharedStatePath, validateLoopbackEndpoint } from '../control/codex-shared.mjs';
import { readJson } from '../control/shared-task-operations.mjs';
import { APP_SERVER_OPERATION_TIMEOUT_MS } from '../discord-bridge/src/app-server-client.mjs';
import { inspectDesktopClientOwner, processIsAlive } from '../discord-bridge/src/client-tool-ownership.mjs';
import { DesktopFirst } from '../discord-bridge/src/desktop-first.mjs';
import { DesktopNavigation } from '../discord-bridge/src/desktop-navigation.mjs';

export function createRuntimeCompletionRoute(client, { endpoint, expectedServerPid, requestId,
  statePath = sharedStatePath, localAppData = process.env.LOCALAPPDATA }) {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(requestId)) {
    throw new Error('A valid refresh request ID is required.');
  }
  const canonicalEndpoint = validateLoopbackEndpoint(endpoint);
  const readRuntime = () => {
    const state = readJson(statePath);
    const owner = inspectDesktopClientOwner({ launcherStatePath: statePath, appServerUrl: canonicalEndpoint });
    const generation = [canonicalEndpoint, state.serverProcessId, state.startedAt].join('|');
    if (owner.state !== 'present' || owner.generation !== generation || state.serverProcessId !== expectedServerPid
      || validateLoopbackEndpoint(state.websocketUrl) !== canonicalEndpoint) {
      throw new Error('The verified shared Desktop changed before completion delivery.');
    }
    return { state, generation };
  };
  const initialGeneration = readRuntime().generation;
  const observeLoadedSince = Date.now();
  const verifyRuntime = () => {
    const current = readRuntime();
    if (current.generation !== initialGeneration) {
      throw new Error('The verified shared Desktop changed before completion delivery.');
    }
    return current;
  };
  const boundedClient = { call: (method, params) => client.call(method, params, APP_SERVER_OPERATION_TIMEOUT_MS) };
  // An unavailable catalog has not issued a navigation. Retry with a fresh
  // context only after DesktopNavigation has confirmed release of the old one.
  const navigation = new DesktopNavigation({ retryDelayMs: 5_000 });
  let navigationUnavailable = false;
  const coordinator = new DesktopFirst({
    directory: path.join(path.dirname(statePath), 'runtime-handoffs', requestId, 'completion-desktop'),
    runtime: () => {
      if (!localAppData) throw new Error('The shared Desktop log location is unavailable.');
      const { state, generation } = verifyRuntime();
      return {
        generation, startedAt: state.startedAt, desktopPids: state.desktopProcessIds.filter(processIsAlive),
        logRoots: [
          path.join(localAppData, 'Codex', 'Logs'),
          path.join(localAppData, 'Packages', state.packageFamilyName, 'LocalCache', 'Local', 'Codex', 'Logs'),
        ],
      };
    },
    readThread: async (threadId) => (await boundedClient.call('thread/read', { threadId, includeTurns: false })).thread,
    prepareNavigation: () => navigation.prepare(boundedClient),
    log: (event) => { if (event === 'desktop-first-api-unavailable') navigationUnavailable = true; },
  });

  return { verifyRuntime, prepareDesktopThread: async (threadId) => {
    const deadline = performance.now() + APP_SERVER_OPERATION_TIMEOUT_MS;
    while (performance.now() < deadline) {
      const outcome = await coordinator.prepare(threadId, { observeLoadedSince });
      if (outcome === 'ready') return;
      if (outcome === 'unconfirmed' || outcome === 'disabled' || navigationUnavailable) {
        throw new Error('Desktop could not be confirmed as the completion task loader. No completion was sent.');
      }
      // An unknown navigation remains claimed. Read its evidence until the
      // ordinary AppServer operation budget expires; never resend it.
      await delay(500);
    }
    throw new Error('Timed out waiting for the completion task to load in Desktop. No completion was sent.');
  } };
}
