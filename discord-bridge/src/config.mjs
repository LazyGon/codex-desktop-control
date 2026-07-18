import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isSnowflake, readJsonIfPresent } from './util.mjs';

export const bridgeRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const configPath = path.join(bridgeRoot, 'config', 'config.json');
export const dataDir = path.join(bridgeRoot, 'data');
export const logDir = path.join(bridgeRoot, 'logs');
const defaultSharedLauncherPath = path.join(
  path.dirname(bridgeRoot),
  'launcher',
  'CodexSharedLauncher.exe',
);

const defaults = {
  controlCategoryName: 'Codex Control',
  archiveCategoryName: 'Codex Archived',
  projectCategoryPrefix: 'Codex - ',
  controlChannelName: 'codex-remote',
  alertsChannelName: 'codex-alerts',
  completionsChannelName: 'codex-completions',
  completionMentionUserId: null,
  defaultWatchLevel: 'normal',
  taskListLimit: 20,
  initialSnapshotMessages: 16,
  liveUpdateIntervalMs: 2500,
  taskSyncIntervalMs: 30_000,
  plainMessageInputEnabled: false,
  autoStartSharedDesktop: true,
  sharedLauncherPath: defaultSharedLauncherPath,
  appServerUrl: null,
};

export function loadConfig() {
  const raw = readJsonIfPresent(configPath);
  if (!raw) throw new Error(`Missing or invalid configuration: ${configPath}`);
  const config = { ...defaults, ...raw };
  if (!raw.initialSnapshotMessages && raw.catchupMessages) config.initialSnapshotMessages = raw.catchupMessages;
  if (!raw.taskSyncIntervalMs && raw.autoCatchupIntervalMs) config.taskSyncIntervalMs = raw.autoCatchupIntervalMs;
  if (!config.completionMentionUserId && Array.isArray(config.allowedUserIds)) {
    [config.completionMentionUserId] = config.allowedUserIds;
  }
  if (config.sharedLauncherPath && !path.isAbsolute(config.sharedLauncherPath)) {
    config.sharedLauncherPath = path.resolve(bridgeRoot, config.sharedLauncherPath);
  }
  const errors = [];
  if (!isSnowflake(config.applicationId)) errors.push('applicationId must be a Discord snowflake.');
  if (!isSnowflake(config.guildId)) errors.push('guildId must be a Discord snowflake.');
  if (!Array.isArray(config.allowedUserIds) || config.allowedUserIds.length === 0) {
    errors.push('allowedUserIds must contain at least one Discord user id.');
  } else if (config.allowedUserIds.some((value) => !isSnowflake(value))) {
    errors.push('Every allowedUserIds entry must be a Discord snowflake.');
  }
  if (!isSnowflake(config.completionMentionUserId)) {
    errors.push('completionMentionUserId must be a Discord snowflake.');
  }
  if (!['quiet', 'normal', 'verbose'].includes(config.defaultWatchLevel)) {
    errors.push('defaultWatchLevel must be quiet, normal, or verbose.');
  }
  if (config.appServerUrl && !/^wss?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/.*)?$/i.test(config.appServerUrl)) {
    errors.push('appServerUrl must be a loopback ws:// or wss:// URL.');
  }
  if (typeof config.autoStartSharedDesktop !== 'boolean') {
    errors.push('autoStartSharedDesktop must be boolean.');
  }
  if (!Number.isInteger(config.taskSyncIntervalMs) || config.taskSyncIntervalMs < 10_000) {
    errors.push('taskSyncIntervalMs must be an integer of at least 10000.');
  }
  if (!Number.isInteger(config.initialSnapshotMessages)
    || config.initialSnapshotMessages < 2
    || config.initialSnapshotMessages > 50) {
    errors.push('initialSnapshotMessages must be an integer from 2 to 50.');
  }
  if (typeof config.plainMessageInputEnabled !== 'boolean') {
    errors.push('plainMessageInputEnabled must be boolean.');
  }
  if (errors.length) throw new Error(`Invalid configuration:\n- ${errors.join('\n- ')}`);
  return config;
}

export function requireBotToken() {
  const token = process.env.DISCORD_BOT_TOKEN?.trim();
  if (!token) throw new Error('DISCORD_BOT_TOKEN is not set. Start through Start-DiscordBridge.ps1.');
  return token;
}

export function discoverEndpoint(config) {
  if (config.appServerUrl) return { url: config.appServerUrl, source: 'config' };
  if (process.env.CODEX_APP_SERVER_WS_URL) {
    return { url: process.env.CODEX_APP_SERVER_WS_URL, source: 'environment' };
  }
  const candidates = [
    path.join(path.dirname(bridgeRoot), 'launcher', 'state', 'current.json'),
  ];
  for (const candidate of candidates) {
    const state = readJsonIfPresent(candidate);
    if (state?.websocketUrl) return { url: state.websocketUrl, source: candidate };
  }
  return { url: 'ws://127.0.0.1:8798', source: 'default' };
}

export function ensureRuntimeDirectories() {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(logDir, { recursive: true });
}
