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
  authorizedUserIds: null,
  authorizedUserId: null,
  completionMentionUserIds: null,
  completionMentionUserId: null,
  defaultWatchLevel: 'normal',
  taskListLimit: 20,
  initialSnapshotMessages: 16,
  liveUpdateIntervalMs: 2500,
  taskSyncIntervalMs: 30_000,
  discordRestTimeoutMs: 120_000,
  plainMessageInputEnabled: false,
  fileShareEnabled: true,
  fileShareChunkBytes: 7_500_000,
  fileShareMaxBytes: 512_000_000,
  fileShareAttachmentsPerMessage: 4,
  fileShareArchiverPath: null,
  autoStartSharedDesktop: true,
  sharedLauncherPath: defaultSharedLauncherPath,
  appServerUrl: null,
};

export function resolveAuthorizationConfig(config) {
  const normalizeIds = (values) => [...new Set((values ?? []).filter(Boolean))];
  const authorizedUserIds = normalizeIds(
    config.authorizedUserIds
      ?? (config.authorizedUserId ? [config.authorizedUserId] : null)
      ?? config.allowedUserIds
      ?? (config.completionMentionUserId ? [config.completionMentionUserId] : []),
  );
  const completionMentionUserIds = normalizeIds(
    config.completionMentionUserIds
      ?? (config.completionMentionUserId ? [config.completionMentionUserId] : []),
  );
  return {
    ...config,
    authorizedUserIds,
    completionMentionUserIds,
    // Retain aliases for older scripts while keeping authentication and
    // notification subscriptions independent.
    authorizedUserId: authorizedUserIds[0] ?? null,
    allowedUserIds: authorizedUserIds,
    completionMentionUserId: completionMentionUserIds[0] ?? null,
  };
}

export function authorizationConfigErrors(config) {
  const errors = [];
  if (!Array.isArray(config.authorizedUserIds) || config.authorizedUserIds.length === 0) {
    errors.push('authorizedUserIds must contain at least one Discord user id.');
  } else if (config.authorizedUserIds.some((value) => !isSnowflake(value))) {
    errors.push('Every authorizedUserIds entry must be a Discord snowflake.');
  }
  if (!Array.isArray(config.completionMentionUserIds)) {
    errors.push('completionMentionUserIds must be an array of Discord user ids.');
  } else if (config.completionMentionUserIds.some((value) => !isSnowflake(value))) {
    errors.push('Every completionMentionUserIds entry must be a Discord snowflake.');
  }
  return errors;
}

export function loadConfig() {
  const raw = readJsonIfPresent(configPath);
  if (!raw) throw new Error(`Missing or invalid configuration: ${configPath}`);
  const config = resolveAuthorizationConfig({ ...defaults, ...raw });
  if (!raw.initialSnapshotMessages && raw.catchupMessages) config.initialSnapshotMessages = raw.catchupMessages;
  if (!raw.taskSyncIntervalMs && raw.autoCatchupIntervalMs) config.taskSyncIntervalMs = raw.autoCatchupIntervalMs;
  if (config.sharedLauncherPath && !path.isAbsolute(config.sharedLauncherPath)) {
    config.sharedLauncherPath = path.resolve(bridgeRoot, config.sharedLauncherPath);
  }
  const errors = [];
  if (!isSnowflake(config.applicationId)) errors.push('applicationId must be a Discord snowflake.');
  if (!isSnowflake(config.guildId)) errors.push('guildId must be a Discord snowflake.');
  errors.push(...authorizationConfigErrors(config));
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
  if (!Number.isInteger(config.discordRestTimeoutMs)
    || config.discordRestTimeoutMs < 15_000
    || config.discordRestTimeoutMs > 900_000) {
    errors.push('discordRestTimeoutMs must be an integer from 15000 to 900000.');
  }
  if (!Number.isInteger(config.initialSnapshotMessages)
    || config.initialSnapshotMessages < 2
    || config.initialSnapshotMessages > 50) {
    errors.push('initialSnapshotMessages must be an integer from 2 to 50.');
  }
  if (typeof config.plainMessageInputEnabled !== 'boolean') {
    errors.push('plainMessageInputEnabled must be boolean.');
  }
  if (typeof config.fileShareEnabled !== 'boolean') {
    errors.push('fileShareEnabled must be boolean.');
  }
  if (!Number.isInteger(config.fileShareChunkBytes)
    || config.fileShareChunkBytes < 1_000_000
    || config.fileShareChunkBytes > 7_500_000) {
    errors.push('fileShareChunkBytes must be an integer from 1000000 to 7500000.');
  }
  if (!Number.isInteger(config.fileShareMaxBytes)
    || config.fileShareMaxBytes < config.fileShareChunkBytes
    || config.fileShareMaxBytes > 2_000_000_000) {
    errors.push('fileShareMaxBytes must be an integer from fileShareChunkBytes to 2000000000.');
  }
  if (!Number.isInteger(config.fileShareAttachmentsPerMessage)
    || config.fileShareAttachmentsPerMessage < 1
    || config.fileShareAttachmentsPerMessage > 10) {
    errors.push('fileShareAttachmentsPerMessage must be an integer from 1 to 10.');
  }
  if (config.fileShareArchiverPath
    && (!path.win32.isAbsolute(config.fileShareArchiverPath)
      || path.win32.basename(config.fileShareArchiverPath).toLocaleLowerCase('en-US') !== '7z.exe')) {
    errors.push('fileShareArchiverPath must be an absolute path to 7z.exe or null.');
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
