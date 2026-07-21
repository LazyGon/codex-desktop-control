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
import { DiscordController } from './discord-controller.mjs';
import { StateStore } from './state-store.mjs';
import { appendJsonLine, atomicWriteJson, nowIso } from './util.mjs';

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
if (config.plainMessageInputEnabled) {
  gatewayIntents.push(GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent);
}

const client = new Client({
  intents: gatewayIntents,
  partials: [Partials.Channel, Partials.Message],
  allowedMentions: { parse: [] },
  rest: { timeout: config.discordRestTimeoutMs },
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

async function shutdown(reason, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  appendJsonLine(processLog, 'shutdown', { reason, exitCode });
  writeRuntime('stopping', { reason });
  clearInterval(runtimeTimer);
  clearInterval(stopTimer);
  await codex.stop().catch((error) => appendJsonLine(processLog, 'codex-stop-error', { error: error.message }));
  client.destroy();
  try { fs.unlinkSync(lockPath); } catch {}
  try { fs.unlinkSync(stopRequestPath); } catch {}
  writeRuntime('stopped', { reason, stoppedAt: nowIso() });
  process.exit(exitCode);
}

const startupAt = nowIso();
appendJsonLine(processLog, 'startup', { pid: process.pid, node: process.version });
writeRuntime('starting');

client.once('clientReady', async () => {
  try {
    await controller.ready();
    codex.start().catch((error) => appendJsonLine(processLog, 'codex-loop-failed', { error: error.stack ?? error.message }));
    writeRuntime('running');
  } catch (error) {
    appendJsonLine(processLog, 'discord-setup-failed', { error: error.stack ?? error.message });
    await shutdown(`Discord setup failed: ${error.message}`, 1);
  }
});

client.on('error', (error) => appendJsonLine(processLog, 'discord-error', { error: error.stack ?? error.message }));
client.on('shardError', (error, shardId) => appendJsonLine(processLog, 'discord-shard-error', { shardId, error: error.message }));

try {
  await client.login(token);
} catch (error) {
  appendJsonLine(processLog, 'discord-login-failed', { error: error.message });
  await shutdown(`Discord login failed: ${error.message}`, 1);
}

runtimeTimer = setInterval(() => writeRuntime(shuttingDown ? 'stopping' : 'running'), 5_000);
stopTimer = setInterval(() => {
  if (fs.existsSync(stopRequestPath)) shutdown('stop requested').catch(() => {});
}, 1_000);

process.on('SIGINT', () => shutdown('SIGINT').catch(() => {}));
process.on('SIGTERM', () => shutdown('SIGTERM').catch(() => {}));
process.on('uncaughtException', (error) => {
  appendJsonLine(processLog, 'uncaught-exception', { error: error.stack ?? error.message });
  shutdown('uncaughtException', 1).catch(() => {});
});
process.on('unhandledRejection', (error) => {
  appendJsonLine(processLog, 'unhandled-rejection', { error: error?.stack ?? String(error) });
});
