import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const controlDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.dirname(controlDir);
export const sharedStatePath = path.join(rootDir, 'launcher', 'state', 'current.json');
export const readyTimeoutMilliseconds = 300_000;

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function readJson(filePath) {
  const content = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
  return JSON.parse(content);
}

function sha256(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex').toUpperCase();
}

function processIsAlive(processId) {
  try {
    process.kill(processId, 0);
    return true;
  } catch {
    return false;
  }
}

export function validateLoopbackEndpoint(value) {
  let endpoint;
  try {
    endpoint = new URL(value);
  } catch {
    throw new Error(`Invalid shared app-server URL: ${value}`);
  }

  const port = Number.parseInt(endpoint.port, 10);
  if (
    endpoint.protocol !== 'ws:'
    || endpoint.hostname !== '127.0.0.1'
    || !Number.isInteger(port)
    || port < 1024
    || port > 65535
    || endpoint.username
    || endpoint.password
    || endpoint.search
    || endpoint.hash
    || (endpoint.pathname !== '' && endpoint.pathname !== '/')
  ) {
    throw new Error(`Refusing non-loopback shared app-server endpoint: ${value}`);
  }

  return `ws://127.0.0.1:${port}`;
}

function readyUrl(websocketUrl) {
  const url = new URL(websocketUrl);
  url.protocol = 'http:';
  url.pathname = '/readyz';
  return url.toString();
}

async function waitUntilReady(websocketUrl, {
  fetchImplementation,
  timeoutMilliseconds,
  isProcessAlive,
  serverProcessId,
}) {
  const deadline = Date.now() + timeoutMilliseconds;
  let lastError = null;

  while (Date.now() < deadline) {
    if (!isProcessAlive(serverProcessId)) {
      throw new Error(`Shared app-server process is not running: ${serverProcessId}`);
    }

    const remaining = deadline - Date.now();
    try {
      const response = await fetchImplementation(readyUrl(websocketUrl), {
        signal: AbortSignal.timeout(Math.max(1, Math.min(10_000, remaining))),
      });
      if (response.status === 200) return;
      lastError = new Error(`Shared app-server readiness returned HTTP ${response.status}.`);
    } catch (error) {
      lastError = error;
    }

    await sleep(Math.min(500, Math.max(0, deadline - Date.now())));
  }

  throw new Error(
    `Shared app-server did not become ready within ${Math.round(timeoutMilliseconds / 1000)} seconds.`
      + (lastError?.message ? ` ${lastError.message}` : ''),
  );
}

function sameRuntime(left, right) {
  return left.websocketUrl === right.websocketUrl
    && left.serverProcessId === right.serverProcessId
    && left.serverExecutable === right.serverExecutable
    && left.serverSha256 === right.serverSha256;
}

export async function validateSharedRuntime({
  statePath = sharedStatePath,
  fetchImplementation = globalThis.fetch,
  timeoutMilliseconds = readyTimeoutMilliseconds,
  isProcessAlive = processIsAlive,
} = {}) {
  if (!fs.existsSync(statePath)) {
    throw new Error(`Shared launcher state was not found: ${statePath}`);
  }

  const state = readJson(statePath);
  const endpoint = validateLoopbackEndpoint(state.websocketUrl);
  const serverProcessId = Number(state.serverProcessId);
  if (!Number.isInteger(serverProcessId) || serverProcessId <= 0) {
    throw new Error('Shared launcher state does not contain a valid server process id.');
  }

  if (state.desktopConnectionVerified !== true) {
    throw new Error('The shared launcher has not verified the Desktop connection.');
  }

  if (typeof state.serverExecutable !== 'string' || !path.isAbsolute(state.serverExecutable)) {
    throw new Error('Shared launcher state does not contain an absolute server executable path.');
  }
  if (!fs.existsSync(state.serverExecutable) || !fs.statSync(state.serverExecutable).isFile()) {
    throw new Error(`Shared app-server executable was not found: ${state.serverExecutable}`);
  }

  if (!/^[A-Fa-f0-9]{64}$/.test(String(state.serverSha256 ?? ''))) {
    throw new Error('Shared launcher state does not contain a valid server SHA-256.');
  }
  const actualHash = sha256(state.serverExecutable);
  if (actualHash !== state.serverSha256.toUpperCase()) {
    throw new Error('Shared app-server executable does not match the launcher state SHA-256.');
  }

  await waitUntilReady(endpoint, {
    fetchImplementation,
    timeoutMilliseconds,
    isProcessAlive,
    serverProcessId,
  });

  const currentState = readJson(statePath);
  if (!sameRuntime(state, currentState)) {
    throw new Error('Shared launcher state changed during CLI validation. Run the command again.');
  }

  return {
    statePath,
    endpoint,
    serverProcessId,
    serverExecutable: state.serverExecutable,
    serverSha256: actualHash,
    packageVersion: state.packageVersion ?? null,
  };
}

export function buildRemoteArguments(values) {
  for (const value of values) {
    if (
      value === '--remote'
      || value.startsWith('--remote=')
      || value === '--remote-auth-token-env'
      || value.startsWith('--remote-auth-token-env=')
    ) {
      throw new Error('The shared CLI owns the remote endpoint; remote override options are not allowed.');
    }
  }
  return values;
}

async function main() {
  const values = process.argv.slice(2);
  const checkOnly = values.length === 1 && values[0] === '--check';
  const codexArguments = checkOnly ? [] : buildRemoteArguments(values);
  const runtime = await validateSharedRuntime();

  if (checkOnly) {
    process.stdout.write(`${JSON.stringify({
      ready: true,
      mode: 'remote-tui',
      endpoint: runtime.endpoint,
      serverProcessId: runtime.serverProcessId,
      serverExecutable: runtime.serverExecutable,
      packageVersion: runtime.packageVersion,
    }, null, 2)}\n`);
    return;
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      'The shared Codex CLI requires an interactive terminal. '
      + 'Use Codex Desktop, Discord Remote UI, or codex-shared --check in a non-TTY environment.',
    );
  }

  const result = spawnSync(runtime.serverExecutable, [
    '--remote',
    runtime.endpoint,
    ...codexArguments,
  ], {
    stdio: 'inherit',
    windowsHide: false,
  });

  if (result.error) throw result.error;
  if (result.signal) {
    process.exitCode = 1;
    return;
  }
  process.exitCode = result.status ?? 1;
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch(error => {
    process.stderr.write(`codex-shared: ${error.message}\n`);
    process.exitCode = 1;
  });
}
