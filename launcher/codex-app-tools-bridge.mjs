#!/usr/bin/env node

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const bridgePath = fileURLToPath(import.meta.url);
const launcherRoot = path.dirname(bridgePath);
const defaultStatePath = path.join(launcherRoot, 'state', 'current.json');

function requireNonEmptyString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Shared runtime state has no ${name}.`);
  }
  return value;
}

function sameWindowsPath(left, right) {
  return path.win32.resolve(left).toLowerCase() === path.win32.resolve(right).toLowerCase();
}

export function parseRuntimeState(text) {
  let state;
  try {
    state = JSON.parse(text);
  } catch {
    throw new Error('Shared runtime state is not valid JSON.');
  }
  if (!Number.isInteger(state.port) || state.port < 1024 || state.port > 65535) {
    throw new Error('Shared runtime state has an invalid port.');
  }
  if (state.websocketUrl !== `ws://127.0.0.1:${state.port}`) {
    throw new Error('Shared runtime state is not bound to the expected loopback WebSocket endpoint.');
  }
  if (state.readyUrl !== `http://127.0.0.1:${state.port}/readyz`) {
    throw new Error('Shared runtime state has an invalid loopback ready endpoint.');
  }
  if (!Number.isInteger(state.serverProcessId) || state.serverProcessId <= 0) {
    throw new Error('Shared runtime state has an invalid serverProcessId.');
  }
  requireNonEmptyString(state.desktopExecutable, 'desktopExecutable');
  requireNonEmptyString(state.serverExecutable, 'serverExecutable');
  requireNonEmptyString(state.packageVersion, 'packageVersion');
  if (
    state.packageFamilyName !== undefined
    && (
      typeof state.packageFamilyName !== 'string'
      || !/^[A-Za-z0-9._-]+_[A-Za-z0-9]+$/.test(state.packageFamilyName)
    )
  ) {
    throw new Error('Shared runtime state has an invalid packageFamilyName.');
  }
  if (!path.win32.isAbsolute(state.desktopExecutable) || !path.win32.isAbsolute(state.serverExecutable)) {
    throw new Error('Shared runtime executable paths must be absolute.');
  }
  if (state.desktopConnectionVerified !== true) {
    throw new Error('Shared runtime state has no verified Desktop connection.');
  }
  return state;
}

export function selectDesktopConnection(payload, expectedExecutable) {
  const matches = Array.isArray(payload?.matches) ? payload.matches : [];
  const unique = new Map();
  for (const match of matches) {
    if (
      Number.isInteger(match?.processId)
      && match.processId > 0
      && typeof match.executablePath === 'string'
      && sameWindowsPath(match.executablePath, expectedExecutable)
      && typeof match.creationTimeUtc === 'string'
      && Number.isFinite(Date.parse(match.creationTimeUtc))
    ) {
      unique.set(match.processId, match);
    }
  }
  if (unique.size !== 1) {
    throw new Error(
      `Expected exactly one Desktop process connected to the shared App Server; found ${unique.size}.`,
    );
  }
  return [...unique.values()][0];
}

export function assertSharedServerOwner(payload, expectedProcessId, expectedExecutable) {
  const listenerProcessIds = Array.isArray(payload?.listenerProcessIds)
    ? [...new Set(payload.listenerProcessIds.filter(Number.isInteger))]
    : [];
  if (listenerProcessIds.length !== 1 || listenerProcessIds[0] !== expectedProcessId) {
    throw new Error('The loopback listener owner does not match shared runtime state.');
  }
  if (
    payload?.server?.processId !== expectedProcessId
    || typeof payload.server.executablePath !== 'string'
    || !sameWindowsPath(payload.server.executablePath, expectedExecutable)
  ) {
    throw new Error('The shared App Server process does not match its exact recorded executable.');
  }
}

export function derivePackageFamilyName(desktopExecutable) {
  const installRoot = path.win32.dirname(path.win32.dirname(desktopExecutable));
  const parts = path.win32.basename(installRoot).split('_');
  if (parts.length < 5) {
    throw new Error('The Desktop package install path does not contain an AppX package identity.');
  }
  const version = parts.at(-4);
  const architecture = parts.at(-3);
  const publisherId = parts.at(-1);
  const packageName = parts.slice(0, -4).join('_');
  if (
    !/^\d+(?:\.\d+){3}$/.test(version)
    || !/^(?:x64|x86|arm|arm64|neutral)$/i.test(architecture)
    || !/^[A-Za-z0-9]+$/.test(publisherId)
    || packageName === ''
  ) {
    throw new Error('The Desktop package install path has an unexpected AppX identity.');
  }
  return `${packageName}_${publisherId}`;
}

function walkFiles(root, predicate, results = []) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const candidate = path.join(root, entry.name);
    if (entry.isDirectory()) {
      walkFiles(candidate, predicate, results);
    } else if (entry.isFile() && predicate(entry.name)) {
      results.push(candidate);
    }
  }
  return results;
}

export function selectNativePipeFromLogs(logFiles, processId, creationTimeUtc) {
  const expectedName = new RegExp(`-${processId}-t0-i1-[^-]+-\\d+\\.log$`, 'i');
  const processStarted = Date.parse(creationTimeUtc);
  const candidates = logFiles
    .filter(file => expectedName.test(path.basename(file)))
    .map(file => ({ file, mtimeMs: fs.statSync(file).mtimeMs }))
    .sort((left, right) => right.mtimeMs - left.mtimeMs);

  for (const candidate of candidates) {
    const handle = fs.openSync(candidate.file, 'r');
    try {
      const buffer = Buffer.alloc(256 * 1024);
      const bytesRead = fs.readSync(handle, buffer, 0, buffer.length, 0);
      const content = buffer.subarray(0, bytesRead).toString('utf8');
      const matches = [...content.matchAll(
        /^(\S+)\s+info\s+\[dynamic-app-tools-native-pipe\]\s+dynamic_app_tools_listening\s+pipePath=(\\\\\.\\pipe\\codex-browser-use-[0-9a-f-]+)\s*$/gim,
      )];
      if (matches.length !== 1) continue;
      const eventTime = Date.parse(matches[0][1]);
      if (
        !Number.isFinite(eventTime)
        || eventTime < processStarted - 5_000
        || eventTime > processStarted + 120_000
      ) {
        continue;
      }
      return { logPath: candidate.file, pipePath: matches[0][2] };
    } finally {
      fs.closeSync(handle);
    }
  }
  throw new Error('No current native app-tools pipe was found for the connected Desktop process.');
}

export function resolveBundledPaths(desktopExecutable) {
  const appRoot = path.win32.dirname(desktopExecutable);
  const resourcesRoot = path.win32.join(appRoot, 'resources');
  const pluginRoot = path.win32.join(
    resourcesRoot,
    'plugins',
    'openai-bundled',
    'plugins',
    'codex-app-tools',
  );
  const bundledNode = path.win32.join(resourcesRoot, 'cua_node', 'bin', 'node.exe');
  const serverScript = path.win32.join(pluginRoot, 'server.mjs');
  const launchScript = path.win32.join(pluginRoot, 'scripts', 'launch_codex_app_tools_mcp.cmd');
  const definitionPath = path.win32.join(pluginRoot, 'desktop-mcp.json');
  for (const candidate of [bundledNode, serverScript, launchScript, definitionPath]) {
    if (!fs.statSync(candidate, { throwIfNoEntry: false })?.isFile()) {
      throw new Error('The installed Desktop package is missing a required codex-app-tools file.');
    }
  }
  const definition = JSON.parse(fs.readFileSync(definitionPath, 'utf8'))?.mcpServers?.codex_app;
  if (
    definition?.command !== 'cmd.exe'
    || !Array.isArray(definition.args)
    || !definition.args.includes('./scripts/launch_codex_app_tools_mcp.cmd')
    || !definition.args.includes('./server.mjs')
  ) {
    throw new Error('The installed codex-app-tools MCP definition is not recognized.');
  }
  return { resourcesRoot, pluginRoot, bundledNode, serverScript };
}

function windowsPowerShell() {
  const windowsRoot = requireNonEmptyString(process.env.WINDIR, 'WINDIR');
  const executable = path.win32.join(
    windowsRoot,
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  if (!fs.statSync(executable, { throwIfNoEntry: false })?.isFile()) {
    throw new Error('Windows PowerShell 5.1 was not found.');
  }
  return executable;
}

function runPowerShellJson(script, environment = {}) {
  const output = execFileSync(windowsPowerShell(), [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64'),
  ], {
    encoding: 'utf8',
    env: { ...process.env, ...environment },
    timeout: 15_000,
    windowsHide: true,
  });
  return JSON.parse(output.replace(/^\uFEFF/, ''));
}

function getConnectedDesktop(state) {
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$portNumber = [int]$env:CODEX_BRIDGE_PROBE_PORT
$expectedExecutable = [IO.Path]::GetFullPath($env:CODEX_BRIDGE_PROBE_DESKTOP)
$expectedServerProcessId = [int]$env:CODEX_BRIDGE_PROBE_SERVER_PID
$listenerProcessIds = @(
    Get-NetTCPConnection -State Listen -LocalPort $portNumber -ErrorAction Stop |
        Where-Object { $_.LocalAddress -eq '127.0.0.1' } |
        ForEach-Object { [int]$_.OwningProcess }
)
$serverProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$expectedServerProcessId" -ErrorAction SilentlyContinue
$server = if (
    $null -ne $serverProcess -and
    -not [string]::IsNullOrWhiteSpace([string]$serverProcess.ExecutablePath)
) {
    [ordered]@{
        processId = [int]$serverProcess.ProcessId
        executablePath = [IO.Path]::GetFullPath([string]$serverProcess.ExecutablePath)
    }
}
else {
    $null
}
$processIds = @(
    Get-NetTCPConnection -State Established -RemotePort $portNumber -ErrorAction Stop |
        Where-Object {
            $_.LocalAddress -in @('127.0.0.1', '::ffff:127.0.0.1', '::1') -and
            $_.RemoteAddress -in @('127.0.0.1', '::ffff:127.0.0.1', '::1')
        } |
        ForEach-Object { [int]$_.OwningProcess } |
        Sort-Object -Unique
)
$matches = @(
    foreach ($processId in $processIds) {
        $process = Get-CimInstance Win32_Process -Filter "ProcessId=$processId" -ErrorAction SilentlyContinue
        if (
            $null -ne $process -and
            $process.Name -eq 'ChatGPT.exe' -and
            -not [string]::IsNullOrWhiteSpace([string]$process.ExecutablePath) -and
            [string]::Equals(
                [IO.Path]::GetFullPath([string]$process.ExecutablePath),
                $expectedExecutable,
                [StringComparison]::OrdinalIgnoreCase)
        ) {
            [ordered]@{
                processId = $processId
                executablePath = [IO.Path]::GetFullPath([string]$process.ExecutablePath)
                creationTimeUtc = ([datetime]$process.CreationDate).ToUniversalTime().ToString('o')
            }
        }
    }
)
[ordered]@{
    listenerProcessIds = @($listenerProcessIds)
    server = $server
    matches = @($matches)
} | ConvertTo-Json -Depth 4 -Compress
`;
  const payload = runPowerShellJson(script, {
    CODEX_BRIDGE_PROBE_PORT: String(state.port),
    CODEX_BRIDGE_PROBE_DESKTOP: state.desktopExecutable,
    CODEX_BRIDGE_PROBE_SERVER_PID: String(state.serverProcessId),
  });
  assertSharedServerOwner(payload, state.serverProcessId, state.serverExecutable);
  return selectDesktopConnection(
    payload,
    state.desktopExecutable,
  );
}

function assertNamedPipeExists(pipePath) {
  const pipeName = pipePath.slice('\\\\.\\pipe\\'.length);
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$pipeName = [string]$env:CODEX_BRIDGE_PROBE_PIPE
$count = @(
    Get-ChildItem -LiteralPath '\\.\pipe\' -ErrorAction Stop |
        Where-Object { [string]$_.Name -ceq $pipeName }
).Count
[ordered]@{ count = $count } | ConvertTo-Json -Compress
`;
  const result = runPowerShellJson(script, { CODEX_BRIDGE_PROBE_PIPE: pipeName });
  if (result.count !== 1) {
    throw new Error('The connected Desktop native app-tools pipe is not available.');
  }
}

export function resolveBridgeRuntime(statePath = defaultStatePath) {
  if (process.platform !== 'win32') {
    throw new Error('The shared codex-app-tools bridge is Windows-only.');
  }
  const state = parseRuntimeState(fs.readFileSync(statePath, 'utf8').replace(/^\uFEFF/, ''));
  if (!fs.statSync(state.desktopExecutable, { throwIfNoEntry: false })?.isFile()) {
    throw new Error('The exact Desktop executable recorded in runtime state is missing.');
  }
  if (!fs.statSync(state.serverExecutable, { throwIfNoEntry: false })?.isFile()) {
    throw new Error('The exact shared App Server executable recorded in runtime state is missing.');
  }
  const desktop = getConnectedDesktop(state);
  const packageFamilyName = state.packageFamilyName
    ?? derivePackageFamilyName(state.desktopExecutable);
  const localAppData = requireNonEmptyString(process.env.LOCALAPPDATA, 'LOCALAPPDATA');
  const logRoot = path.win32.join(
    localAppData,
    'Packages',
    packageFamilyName,
    'LocalCache',
    'Local',
    'Codex',
    'Logs',
  );
  if (!fs.statSync(logRoot, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error('The current Desktop log directory was not found.');
  }
  const logFiles = walkFiles(logRoot, name => name.toLowerCase().endsWith('.log'));
  const nativePipe = selectNativePipeFromLogs(logFiles, desktop.processId, desktop.creationTimeUtc);
  assertNamedPipeExists(nativePipe.pipePath);
  const bundled = resolveBundledPaths(state.desktopExecutable);
  return { state, desktop, nativePipe, bundled };
}

export async function waitForBridgeRuntime({
  resolve = () => resolveBridgeRuntime(),
  timeoutMilliseconds = 20_000,
  retryMilliseconds = 250,
} = {}) {
  const deadline = Date.now() + timeoutMilliseconds;
  let lastError = null;
  do {
    try {
      return resolve();
    } catch (error) {
      lastError = error;
    }
    if (Date.now() >= deadline) break;
    await new Promise(resolveDelay => setTimeout(resolveDelay, retryMilliseconds));
  } while (true);
  throw new Error(
    `The Desktop app-tools transport did not become safe within ${timeoutMilliseconds} ms: ${lastError?.message ?? 'unknown error'}`,
  );
}

async function run() {
  const resolved = await waitForBridgeRuntime();
  if (process.argv.slice(2).includes('--probe')) {
    process.stdout.write(`${JSON.stringify({
      ready: true,
      desktopProcessId: resolved.desktop.processId,
      packageVersion: resolved.state.packageVersion,
      pluginRoot: resolved.bundled.pluginRoot,
    })}\n`);
    return;
  }

  const command = process.env.ComSpec
    ?? path.win32.join(requireNonEmptyString(process.env.WINDIR, 'WINDIR'), 'System32', 'cmd.exe');
  if (!fs.statSync(command, { throwIfNoEntry: false })?.isFile()) {
    throw new Error('cmd.exe was not found.');
  }
  const child = spawn(command, [
    '/d',
    '/s',
    '/c',
    'call',
    './scripts/launch_codex_app_tools_mcp.cmd',
    './server.mjs',
  ], {
    cwd: resolved.bundled.pluginRoot,
    env: {
      ...process.env,
      CODEX_APP_TOOLS_PIPE_PATH: resolved.nativePipe.pipePath,
      CODEX_MCP_NODE_PATH: resolved.bundled.bundledNode,
      CODEX_BROWSER_USE_NODE_PATH: resolved.bundled.bundledNode,
      CODEX_ELECTRON_RESOURCES_PATH: resolved.bundled.resourcesRoot,
      CODEX_CLI_PATH: resolved.state.serverExecutable,
    },
    stdio: 'inherit',
    windowsHide: true,
  });

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      try {
        child.kill(signal);
      } catch {
        // The child already exited.
      }
    });
  }
  const exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => resolve(Number.isInteger(code) ? code : 1));
  });
  process.exitCode = exitCode;
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : null;
if (invokedPath === import.meta.url) {
  run().catch(error => {
    process.stderr.write(`codex-app-tools bridge: ${error.message}\n`);
    process.exitCode = 1;
  });
}
