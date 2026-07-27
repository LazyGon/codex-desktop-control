import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { Client, GatewayIntentBits, Partials } from 'discord.js';
import {
  bridgeRoot,
  dataDir,
  discoverEndpoint,
  ensureRuntimeDirectories,
  loadConfig,
  logDir,
  requireBotToken,
} from './config.mjs';
import { CodexService } from './codex-service.mjs';
import { isTransientCommunicationError } from './communication-error.mjs';
import { DiscordController } from './discord-controller.mjs';
import { createDiscordRestAgent, discordRestOptions } from './discord-network.mjs';
import { StateStore } from './state-store.mjs';
import {
  appendJsonLine,
  atomicWriteJson,
  nowIso,
  sleep,
} from './util.mjs';

ensureRuntimeDirectories();
const config = loadConfig();
const token = requireBotToken();
const stateStore = new StateStore(dataDir, config.guildId);
const runtimePath = path.join(dataDir, 'runtime.json');
const lockPath = path.join(dataDir, 'bridge.lock');
const stopRequestPath = path.join(dataDir, 'stop.request');
const processLog = path.join(logDir, `bridge-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}.jsonl`);

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireLock() {
  try {
    const descriptor = fs.openSync(lockPath, 'wx');
    fs.writeFileSync(descriptor, `${process.pid}\n`, 'utf8');
    fs.closeSync(descriptor);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const existingPid = Number.parseInt(fs.readFileSync(lockPath, 'utf8').trim(), 10);
    if (Number.isInteger(existingPid) && processIsAlive(existingPid)) {
      throw new Error(`Codex Discord Bridge is already running as PID ${existingPid}.`);
    }
    fs.unlinkSync(lockPath);
    acquireLock();
  }
}

acquireLock();
if (fs.existsSync(stopRequestPath)) fs.unlinkSync(stopRequestPath);

const gatewayIntents = [GatewayIntentBits.Guilds];
if (config.plainMessageInputEnabled || config.textTransferEnabled) {
  gatewayIntents.push(GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent);
}

const discordRestAgent = createDiscordRestAgent(config);
const client = new Client({
  intents: gatewayIntents,
  partials: [Partials.Channel, Partials.Message],
  allowedMentions: { parse: [] },
  rest: discordRestOptions(config, discordRestAgent),
});
const codex = new CodexService({ config, stateStore, discoverEndpoint, logDir });
const controller = new DiscordController({ client, codex, stateStore, config, logDir });
controller.attach();

let shuttingDown = false;
let runtimeTimer = null;
let stopTimer = null;

function writeRuntime(phase, extra = {}) {
  atomicWriteJson(runtimePath, {
    schemaVersion: 1,
    phase,
    pid: process.pid,
    bridgeRoot,
    startedAt: startupAt,
    updatedAt: nowIso(),
    discordReady: client.isReady(),
    discordUser: client.user?.tag ?? null,
    codex: codex.status(),
    ...extra,
  });
}

function communicationRetryDelay(attempt) {
  return Math.min(1_000 * (2 ** Math.min(Math.max(0, attempt - 1), 8)), 300_000);
}

async function waitForCommunicationRetry(delayMs) {
  const deadline = Date.now() + delayMs;
  while (!shuttingDown && Date.now() < deadline) {
    if (fs.existsSync(stopRequestPath)) {
      await shutdown('stop requested');
      return false;
    }
    await sleep(Math.min(1_000, deadline - Date.now()));
  }
  return !shuttingDown;
}

function logRecoverableCommunicationError(source, error, extra = {}) {
  appendJsonLine(processLog, 'recoverable-communication-error', {
    source,
    error: error?.stack ?? String(error),
    ...extra,
  });
}

async function shutdown(reason, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  appendJsonLine(processLog, 'shutdown', { reason, exitCode });
  writeRuntime('stopping', { reason });
  clearInterval(runtimeTimer);
  clearInterval(stopTimer);
  const controllerStop = controller.stop();
  await codex.stop().catch((error) => appendJsonLine(processLog, 'codex-stop-error', { error: error.message }));
  await controllerStop.catch((error) => appendJsonLine(
    processLog,
    'controller-stop-error',
    { error: error.message },
  ));
  client.destroy();
  await discordRestAgent.close().catch((error) => appendJsonLine(
    processLog,
    'discord-agent-close-error',
    { error: error.message },
  ));
  try { fs.unlinkSync(lockPath); } catch {}
  try { fs.unlinkSync(stopRequestPath); } catch {}
  writeRuntime('stopped', { reason, stoppedAt: nowIso() });
  process.exit(exitCode);
}

const startupAt = nowIso();
appendJsonLine(processLog, 'startup', { pid: process.pid, node: process.version });
writeRuntime('starting');

client.once('clientReady', () => {
  const initializeController = async () => {
    let attempt = 0;
    while (!shuttingDown) {
      try {
        await controller.ready();
        codex.start().catch((error) => appendJsonLine(processLog, 'codex-loop-failed', { error: error.stack ?? error.message }));
        writeRuntime('running');
        return;
      } catch (error) {
        if (!isTransientCommunicationError(error)) {
          appendJsonLine(processLog, 'discord-setup-failed', { error: error.stack ?? error.message });
          await shutdown(`Discord setup failed: ${error.message}`, 1);
          return;
        }
        attempt += 1;
        const retryDelayMs = communicationRetryDelay(attempt);
        logRecoverableCommunicationError('discord-setup', error, { attempt, retryDelayMs });
        writeRuntime('starting', { setupRetryAttempt: attempt, setupRetryDelayMs: retryDelayMs });
        if (!await waitForCommunicationRetry(retryDelayMs)) return;
      }
    }
  };
  initializeController().catch((error) => {
    appendJsonLine(processLog, 'discord-setup-retry-failed', { error: error.stack ?? error.message });
    shutdown('Discord setup retry loop failed', 1).catch(() => {});
  });
});

async function loginDiscord() {
  let attempt = 0;
  while (!shuttingDown) {
    try {
      await client.login(token);
      return;
    } catch (error) {
      if (!isTransientCommunicationError(error)) {
        appendJsonLine(processLog, 'discord-login-failed', { error: error.message });
        await shutdown(`Discord login failed: ${error.message}`, 1);
        return;
      }
      attempt += 1;
      const retryDelayMs = communicationRetryDelay(attempt);
      logRecoverableCommunicationError('discord-login', error, { attempt, retryDelayMs });
      writeRuntime('starting', { loginRetryAttempt: attempt, loginRetryDelayMs: retryDelayMs });
      if (!await waitForCommunicationRetry(retryDelayMs)) return;
    }
  }
}

client.on('error', (error) => appendJsonLine(processLog, 'discord-error', { error: error.stack ?? error.message }));
client.on('shardError', (error, shardId) => appendJsonLine(processLog, 'discord-shard-error', { shardId, error: error.message }));

process.on('SIGINT', () => shutdown('SIGINT').catch(() => {}));
process.on('SIGTERM', () => shutdown('SIGTERM').catch(() => {}));
process.on('uncaughtException', (error) => {
  if (isTransientCommunicationError(error)) {
    logRecoverableCommunicationError('uncaughtException', error);
    return;
  }
  appendJsonLine(processLog, 'uncaught-exception', { error: error.stack ?? error.message });
  shutdown('uncaughtException', 1).catch(() => {});
});
process.on('unhandledRejection', (error) => {
  if (isTransientCommunicationError(error)) {
    logRecoverableCommunicationError('unhandledRejection', error);
    return;
  }
  appendJsonLine(processLog, 'unhandled-rejection', { error: error?.stack ?? String(error) });
});

await loginDiscord();

runtimeTimer = setInterval(() => writeRuntime(shuttingDown ? 'stopping' : 'running'), 5_000);
stopTimer = setInterval(() => {
  if (fs.existsSync(stopRequestPath)) shutdown('stop requested').catch(() => {});
}, 1_000);
