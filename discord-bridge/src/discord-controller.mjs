import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  ModalBuilder,
  OverwriteType,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextInputBuilder,
  TextInputStyle,
  ThreadAutoArchiveDuration,
} from 'discord.js';
import {
  appendJsonLine,
  completionTextFromSession,
  completionNoticeContent,
  finalTextFromTurn,
  formatReasoningField,
  itemResultSummary,
  itemSummary,
  planDiscordTextDelivery,
  projectDescriptor,
  randomKey,
  reasoningSummaryFromTurn,
  sleep,
  taskChannelName,
  threadStatusEmoji,
  threadStatusLabel,
  truncate,
} from './util.mjs';
import { commandPayload } from './commands.mjs';
import {
  CONTROL_PANEL_MARKER,
  controlPanelPayload,
  projectVisibilityPayload,
  recentHistoryPayload,
  taskPanelMarker,
  taskPanelPayload,
} from './discord-panels.mjs';
import {
  completedTurnsSince,
  historicalAssistantItems,
  RECENT_HISTORY_DAY_OPTIONS,
  recentHistoryCutoffMs,
  turnTimestampMs,
  uuidV7TimestampMs,
} from './recent-history.mjs';
import { readSessionTurnCardOrder } from './session-message-order.mjs';
import {
  contentCardComponents,
  fileBrowserPayload,
  formatFileSize,
  linkedFilePickerPayload,
} from './discord-file-ui.mjs';
import {
  extractLocalFileReferences,
  isDiscordInlineImageTarget,
  listProjectDirectory,
  resolveShareFile,
  safeAttachmentName,
  uniqueDiscordAttachmentName,
} from './local-file-share.mjs';
import {
  cleanupStaleSplitArchives,
  createSplit7zArchive,
  createSplit7zGitArchive,
  createSplit7zProjectArchive,
  createSplitZipArchive,
  disposeSplitArchive,
  gitArchiveManifest,
  hashResolvedFile,
  linkedFilesArchiveManifest,
  projectArchiveManifest,
  readArchiveVolume,
  readHashedFile,
  splitArchiveManifest,
} from './split-archive.mjs';
import { LatestUpdateQueue } from './latest-update-queue.mjs';
import { codexRetryStatusText } from './communication-error.mjs';
import {
  accountUsageEmbed,
  goalPayload,
  resourceInventoryEmbed,
  reviewPayload,
  secondarySettingsPayload,
  taskControlPayload,
  taskStatusEmbed,
  terminalPayload,
} from './codex-control-ui.mjs';
import { AutomationStore } from './automation-store.mjs';
import {
  ClientToolRouter,
  ClientToolUnavailableError,
} from './client-tool-router.mjs';
import {
  clientToolRequestKey,
  inspectDesktopClientOwner,
  requiresExclusiveClientToolOwner,
} from './client-tool-ownership.mjs';
import { TextTransferStore } from './text-transfer-store.mjs';
import {
  projectDescriptorForThread,
  readDesktopProjectSnapshot,
} from './desktop-project-state.mjs';
import {
  isTaskScopedCodexArtifactRoot,
  readSessionWorkspaceRoots,
} from './session-workspace-roots.mjs';
import { IncomingAttachmentStore } from './incoming-attachment-store.mjs';
import {
  coalesceCodexNotification,
  isControllerCodexNotification,
} from './codex-notification-buffer.mjs';
import {
  codexImageFilesFromItem,
  codexImagePathAttachmentName,
  hasCodexImageContent,
} from './codex-image-item.mjs';

const COLORS = {
  neutral: 0x5865f2,
  active: 0x2b8a3e,
  warning: 0xf0b232,
  error: 0xc92a2a,
  completed: 0x1971c2,
  user: 0xe67e22,
};

const MAX_DISCORD_MESSAGE_ATTACHMENTS = 10;

export const ATTACHMENT_ONLY_PROMPT = [
  '添付ファイルがユーザーからの依頼です。',
  '内容を読み取り、意図を判断して、可能な分析・回答・作業を進めてください。',
  '単なる確認だけで終わらず、意図を確定できない場合だけ質問してください。',
].join('');

function messageOptions(content, extra = {}) {
  return { content, allowedMentions: { parse: [] }, ...extra };
}

function channelMention(channelId) {
  return `<#${channelId}>`;
}

export async function postTaskSyncSummary(client, stateStore, result) {
  const channelId = stateStore.snapshot().infrastructure.syncChannelId;
  const channel = channelId ? await client.channels.fetch(channelId).catch(() => null) : null;
  if (!channel) return false;
  const links = result.channels.slice(0, 10).map(channelMention).join(' ');
  await channel.send(messageOptions(
    `全タスク同期を更新しました。新規 ${result.created} / 移動 ${result.moved} / Discord削除 ${result.deleted ?? 0} / 失敗 ${result.failed}${links ? `\n${links}` : ''}`,
  ));
  return true;
}

function taskTitleFromChannelName(channelName) {
  const withoutStatus = String(channelName ?? '').replace(/^[🟢⚫]\s*-?\s*/u, '');
  return withoutStatus.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim() || 'New task';
}

export function subagentMetadata(thread) {
  const spawn = thread?.source?.subAgent?.thread_spawn
    ?? thread?.source?.subAgent?.threadSpawn
    ?? {};
  return {
    parentThreadId: thread?.parentThreadId ?? spawn.parent_thread_id ?? spawn.parentThreadId ?? null,
    depth: Number.isSafeInteger(spawn.depth) ? spawn.depth : null,
    agentPath: spawn.agent_path ?? spawn.agentPath ?? null,
    nickname: spawn.agent_nickname ?? spawn.agentNickname ?? null,
    role: spawn.agent_role ?? spawn.agentRole ?? null,
  };
}

export function isSubagentCodexThread(thread) {
  return Boolean(thread?.id && !thread.ephemeral && subagentMetadata(thread).parentThreadId);
}

export function shouldPeriodicallySyncSubagent(binding) {
  if (!binding) return true;
  if (binding.taskStatus === 'active') return true;
  if (!binding.taskStatus || binding.taskStatus === 'unknown') return !binding.discordArchived;
  return false;
}

export function isActiveSubagentThread(thread) {
  return thread?.status?.type === 'active';
}

export function subagentIdsFromThread(thread) {
  const ids = [];
  for (const turn of thread?.turns ?? []) {
    for (const item of turn.items ?? []) {
      if (item.type === 'subAgentActivity' && item.agentThreadId) ids.push(item.agentThreadId);
      if (item.type === 'collabAgentToolCall') ids.push(...(item.receiverThreadIds ?? []));
    }
  }
  return [...new Set(ids.filter(Boolean))];
}

export function subagentOwnTurns(thread) {
  if (!isSubagentCodexThread(thread)) return thread?.turns ?? [];
  const childTimestamp = uuidV7TimestampMs(thread.id);
  if (childTimestamp === null) return thread?.turns ?? [];
  return (thread.turns ?? []).filter((turn) => {
    const timestamp = uuidV7TimestampMs(turn.id) ?? turnTimestampMs(turn);
    if (timestamp === null || timestamp < childTimestamp) return false;
    if (timestamp > childTimestamp) return true;
    return String(turn.id ?? '').localeCompare(String(thread.id)) >= 0;
  });
}

export function subagentDiscordThreadName(thread) {
  const metadata = subagentMetadata(thread);
  const pathName = String(metadata.agentPath ?? '')
    .split('/')
    .filter(Boolean)
    .at(-1)
    ?.replaceAll('_', '-')
    ?? 'subagent';
  const identity = [metadata.nickname, pathName].filter(Boolean).join(' · ');
  const status = thread?.status?.type === 'active' ? '🟢' : '⚫';
  return truncate(`${status} ${identity} · ${String(thread?.id ?? '').slice(-8)}`, 100, '');
}

function subagentMarker(threadId) {
  return `Codex subagent: ${threadId}`;
}

export function managedProjectCategoryCleanupPlan(categories, active) {
  const occupied = categories.filter((category) => category.children.cache.size > 0);
  if (!active) {
    return occupied.length > 0
      ? { keep: categories, remove: [], removeProject: false }
      : { keep: [], remove: categories, removeProject: true };
  }
  const keep = occupied.length > 0 ? occupied : categories.slice(0, 1);
  const keepIds = new Set(keep.map((category) => category.id));
  return {
    keep,
    remove: categories.filter((category) => !keepIds.has(category.id)),
    removeProject: false,
  };
}

export function managedProjectCategoryNames(descriptor, projectCategories = [], count = 1) {
  const collision = projectCategories
    .find((project) => project.projectKey !== descriptor.key && project.name === descriptor.name);
  const baseName = collision
    ? truncate(`${descriptor.name} - ${Buffer.from(descriptor.key, 'utf8').toString('base64url').slice(-6).toLowerCase()}`, 100, '')
    : descriptor.name;
  const total = Math.max(0, Math.trunc(Number(count) || 0));
  return Array.from({ length: total }, (_, index) => (
    index === 0 ? baseName : truncate(`${baseName} (${index + 1})`, 100, '')
  ));
}

export function projectVisibilityCatalog({
  projectCategories = [],
  hiddenProjects = [],
  bindings = [],
  categoryPrefix = 'Codex - ',
} = {}) {
  const projects = new Map();
  const merge = (projectKey, value) => {
    if (!projectKey) return;
    projects.set(projectKey, {
      taskCount: 0,
      hidden: false,
      ...projects.get(projectKey),
      ...value,
      projectKey,
    });
  };
  for (const project of projectCategories) merge(project.projectKey, project);
  for (const binding of bindings) {
    let descriptor;
    try {
      descriptor = projectDescriptor(binding.cwd, categoryPrefix);
    } catch {
      descriptor = projectDescriptor(null, categoryPrefix);
    }
    const projectKey = binding.projectKey ?? descriptor.key;
    const current = projects.get(projectKey);
    merge(projectKey, {
      projectId: binding.projectId ?? current?.projectId ?? descriptor.id,
      path: current?.path ?? descriptor.path,
      name: current?.name ?? descriptor.name,
      taskCount: (current?.taskCount ?? 0) + 1,
    });
  }
  for (const project of hiddenProjects) merge(project.projectKey, { ...project, hidden: true });
  return [...projects.values()]
    .sort((left, right) => Number(left.hidden) - Number(right.hidden)
      || String(left.path).localeCompare(String(right.path)));
}

export function completionRecoveryCandidate(binding) {
  const entries = Object.entries(binding?.turnMessages ?? {});
  const lastCompletedTurnId = binding?.lastCompletedTurnId ?? null;
  const newerInProgress = entries
    .filter(([turnId, record]) => record?.status === 'inProgress'
      && (!lastCompletedTurnId || turnId > lastCompletedTurnId))
    .map(([turnId]) => turnId)
    .sort()
    .at(-1);
  if (newerInProgress) return newerInProgress;
  if (!lastCompletedTurnId) return null;
  const latestRecord = binding.turnMessages?.[lastCompletedTurnId];
  if (!latestRecord || latestRecord.status === 'inProgress') return null;
  if (!latestRecord.cardMessageId || !(latestRecord.finalMessageIds?.length > 0)) {
    return lastCompletedTurnId;
  }
  return null;
}

export function orderedSessionCardItems(turn, userItems, detailItems, recordedOrder = []) {
  const users = new Map((userItems ?? []).map((item) => [item.id, item]));
  const details = new Map((detailItems ?? []).map((item) => [item.id, item]));
  const ordered = [];
  for (const entry of recordedOrder ?? []) {
    const source = entry.kind === 'user' ? users : details;
    const item = source.get(entry.id);
    if (item && source.delete(entry.id)) ordered.push({ kind: entry.kind, item });
  }
  let userIndex = 0;
  for (const item of turn?.items ?? []) {
    if (item.type === 'userMessage') {
      const fallback = (userItems ?? [])[userIndex];
      const user = users.get(item.id) ?? fallback;
      userIndex += 1;
      if (user && users.delete(user.id)) ordered.push({ kind: 'user', item: user });
      continue;
    }
    const detail = details.get(item.id);
    if (detail && details.delete(detail.id)) ordered.push({ kind: 'detail', item: detail });
  }
  for (const item of users.values()) ordered.push({ kind: 'user', item });
  for (const item of details.values()) ordered.push({ kind: 'detail', item });
  return ordered;
}

export function sessionOrderRepairMessageIds(messages, turnIds, botUserId) {
  const targets = new Set(turnIds ?? []);
  return [...(messages?.values?.() ?? [])]
    .filter((message) => message.author?.id === botUserId)
    .filter((message) => !message.embeds?.some(
      (embed) => embed.title === 'Codex context compacted',
    ))
    .filter((message) => message.embeds?.some((embed) => embed.fields?.some(
      (field) => field.name === 'Turn'
        && targets.has(String(field.value ?? '').replaceAll('`', '').trim()),
    )))
    .map((message) => message.id);
}

export async function runAfterTranscriptBarrier(transcriptSyncPromises, threadId, operation) {
  const barrier = transcriptSyncPromises.get(threadId);
  if (barrier) await barrier.catch(() => {});
  return operation();
}

export function emptyDuplicateUserEntryIds(userEntries, userItem) {
  const text = String(userItem?.text ?? '').trim();
  return Object.entries(userEntries ?? {})
    .filter(([entryId, entry]) => entryId !== userItem?.id
      && !(entry.messageIds ?? []).length
      && String(entry.text ?? '').trim() === text)
    .map(([entryId]) => entryId);
}

function projectArchiveVolumeText(config) {
  const volume = formatFileSize(config.fileShareChunkBytes ?? 7_500_000);
  return `source/archiveの総量上限は設けず、${volume}以下のvolumeへ分割して1件ずつ送信します。容量に応じて作成・送信に時間がかかります。`;
}

function userInputField(id, label, { required = true, secret = false, value = null } = {}) {
  const field = new TextInputBuilder()
    .setCustomId(id)
    .setLabel(truncate(label, 45, ''))
    .setRequired(required)
    .setStyle(secret ? TextInputStyle.Short : TextInputStyle.Paragraph)
    .setMaxLength(4000);
  if (value) field.setValue(truncate(value, 4000, ''));
  return new ActionRowBuilder().addComponents(field);
}

export class DiscordController {
  constructor({
    client,
    codex,
    stateStore,
    config,
    logDir,
    automationStore = new AutomationStore(),
    clientToolRouter = null,
    desktopClientInspector = inspectDesktopClientOwner,
    textTransferStore = null,
    incomingAttachmentStore = null,
  }) {
    this.client = client;
    this.codex = codex;
    this.stateStore = stateStore;
    this.config = config;
    this.authorizedUserIds = [...new Set(
      config.authorizedUserIds
      ?? config.allowedUserIds
      ?? [config.authorizedUserId].filter(Boolean),
    )];
    this.completionMentionUserIds = [...new Set(
      config.completionMentionUserIds
      ?? [config.completionMentionUserId].filter(Boolean),
    )];
    this.automationStore = automationStore;
    this.clientToolRouter = clientToolRouter ?? new ClientToolRouter({ codex, automationStore });
    this.desktopClientInspector = desktopClientInspector;
    this.clientToolOwnerTimeoutMs = config.clientToolOwnerTimeoutMs ?? 300_000;
    this.logPath = path.join(logDir, `discord-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}.jsonl`);
    this.fileTransferTempRoot = path.join(path.dirname(logDir), 'data', 'file-transfers');
    this.incomingAttachmentStore = incomingAttachmentStore ?? new IncomingAttachmentStore(
      path.join(path.dirname(logDir), 'data', 'incoming-files'),
      {
        maxFileBytes: config.inputAttachmentMaxBytes ?? 512_000_000,
        maxTotalBytes: config.inputAttachmentTotalMaxBytes ?? 512_000_000,
        maxCount: config.inputAttachmentMaxCount ?? 10,
        timeoutMs: config.discordRestTimeoutMs ?? 300_000,
      },
    );
    this.textTransferStore = textTransferStore ?? new TextTransferStore(
      path.join(path.dirname(logDir), 'data', 'transfer-text'),
    );
    this.transferTextChannelId = stateStore.snapshot?.().infrastructure?.transferTextChannelId ?? null;
    this.pendingRequests = new Map();
    this.pendingClientToolRequests = new Map();
    this.codexEventSequence = 0;
    this.pendingActions = new Map();
    this.turnViews = new Map();
    this.recentUserInputs = [];
    this.taskSyncTimer = null;
    this.taskSyncInitialTimer = null;
    this.taskSyncPromise = null;
    this.taskSyncDebounceTimer = null;
    this.transcriptSyncPromises = new Map();
    this.transcriptSyncTail = Promise.resolve();
    this.completionRecoveryJobs = new Map();
    this.turnCompletionPromises = new Map();
    this.completionNoticePromises = new Map();
    this.completionRetryBaseMs = config.completionRetryBaseMs ?? 1_000;
    this.completionRetryMaxMs = config.completionRetryMaxMs ?? 300_000;
    this.controllerShutdownTimeoutMs = config.controllerShutdownTimeoutMs ?? 300_000;
    this.recentHistoryRestoreJob = null;
    this.recentHistoryRestorePromise = null;
    this.notificationQueues = new Map();
    this.notificationBuffers = new Map();
    this.subscriptionSyncPromises = new Map();
    this.discordMessageQueues = new Map();
    this.liveCardMovePromises = new Map();
    this.pendingChannelBindings = new Map();
    this.panelSyncPromises = new Map();
    this.projectCategoryPromises = new Map();
    this.subagentSyncPromises = new Map();
    this.nonSubagentThreadIds = new Map();
    this.internalChannelMoves = new Map();
    this.internalChannelNames = new Map();
    this.taskChannelMetadataUpdates = new LatestUpdateQueue({
      equals: (left, right) => left.name === right.name && left.topic === right.topic,
      apply: (update) => this.#applyTaskChannelMetadata(update),
      onError: (error, update) => {
        this.#log('task-channel-metadata-update-error', {
          channelId: update.channel.id,
          name: update.name,
          error: error.stack ?? error.message,
        });
      },
    });
    this.canPinControlPanels = false;
    this.lastConnectionState = null;
    this.infrastructureReady = null;
    this.stopping = false;
    this.shutdownPromise = null;
  }

  attach() {
    this.client.on('interactionCreate', (interaction) => this.#handleInteraction(interaction));
    this.client.on('messageCreate', (message) => this.#queueDiscordMessage(message));
    this.client.on('channelUpdate', (oldChannel, newChannel) => this.#handleChannelUpdate(oldChannel, newChannel).catch((error) => {
      this.#log('channel-ui-handler-error', {
        channelId: newChannel.id,
        oldParentId: oldChannel.parentId,
        newParentId: newChannel.parentId,
        oldName: oldChannel.name,
        newName: newChannel.name,
        error: error.stack ?? error.message,
      });
      this.#postAlert(`Discordチャンネル操作によるタスク更新に失敗しました: ${newChannel.id}\n${error.message}`, 'error').catch(() => {});
    }));
    this.codex.on('notification', (message) => {
      const eventSequence = ++this.codexEventSequence;
      if (isControllerCodexNotification(message)) {
        this.#queueCodexNotification(message, eventSequence);
      }
    });
    this.codex.on('serverRequest', (request) => this.#handleServerRequest(
      request,
      ++this.codexEventSequence,
    ));
    this.codex.on('connectionState', (status) => this.#handleConnectionState(status));
    this.codex.on('subscriptionRestored', (event) => this.#queueSubscriptionRestored(event));
    this.codex.on('subscriptionError', (event) => {
      if (this.stopping) return;
      if (this.#isBindingHidden(this.stateStore.binding(event.binding.threadId) ?? event.binding)) return;
      this.#postAlert(
        `購読復元失敗: ${event.binding.threadId}\n${event.error.message}`,
        'error',
      ).catch(() => {});
    });
  }

  stop() {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.stopping = true;
    if (this.taskSyncTimer) clearInterval(this.taskSyncTimer);
    if (this.taskSyncInitialTimer) clearTimeout(this.taskSyncInitialTimer);
    if (this.taskSyncDebounceTimer) clearTimeout(this.taskSyncDebounceTimer);
    this.taskSyncTimer = null;
    this.taskSyncInitialTimer = null;
    this.taskSyncDebounceTimer = null;
    this.#clearPendingClientToolRequests('controller-stop');
    for (const view of this.turnViews.values()) {
      if (view.timer) clearTimeout(view.timer);
      if (view.elapsedTimer) clearTimeout(view.elapsedTimer);
      view.timer = null;
      view.elapsedTimer = null;
    }
    const recoveryJobs = [...this.completionRecoveryJobs.values()];
    for (const job of recoveryJobs) {
      if (job.timer) clearTimeout(job.timer);
    }
    this.completionRecoveryJobs.clear();
    const pending = [
      ['task-sync', this.taskSyncPromise],
      ['transcript-tail', this.transcriptSyncTail],
      ['recent-history', this.recentHistoryRestorePromise],
      ...[...this.notificationQueues].map(([key, promise]) => [`notification:${key}`, promise]),
      ...[...this.subscriptionSyncPromises].map(([key, promise]) => [`subscription:${key}`, promise]),
      ...[...this.discordMessageQueues].map(([key, promise]) => [`discord-message:${key}`, promise]),
      ...[...this.liveCardMovePromises].map(([key, promise]) => [`live-card:${key}`, promise]),
      ...[...this.turnViews].map(([key, view]) => [`turn-mutation:${key}`, view.mutationPromise]),
      ...[...this.transcriptSyncPromises].map(([key, promise]) => [`transcript:${key}`, promise]),
      ...[...this.panelSyncPromises].map(([key, promise]) => [`panel:${key}`, promise]),
      ...[...this.projectCategoryPromises].map(([key, promise]) => [`category:${key}`, promise]),
      ...[...this.subagentSyncPromises].map(([key, promise]) => [`subagent:${key}`, promise]),
      ...[...this.turnCompletionPromises].map(([key, promise]) => [`turn-completion:${key}`, promise]),
      ...[...this.completionNoticePromises].map(([key, promise]) => [`completion-notice:${key}`, promise]),
      ...recoveryJobs.map((job) => [`completion:${job.threadId}:${job.turnId ?? 'latest'}`, job.promise]),
    ].filter(([, promise]) => Boolean(promise));
    const unsettled = new Set(pending.map(([name]) => name));
    this.#log('controller-stop-wait', { pending: [...unsettled] });
    const settlement = Promise.allSettled(pending.map(([name, promise]) => Promise.resolve(promise)
      .finally(() => unsettled.delete(name))));
    this.shutdownPromise = new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.#log('controller-stop-timeout', {
          timeoutMs: this.controllerShutdownTimeoutMs,
          pending: [...unsettled],
        });
        resolve({ timedOut: true, pending: [...unsettled] });
      }, this.controllerShutdownTimeoutMs);
      timeout.unref?.();
      settlement.then((results) => {
        clearTimeout(timeout);
        resolve({ timedOut: false, results });
      });
    });
    return this.shutdownPromise;
  }

  async ready() {
    if (this.config.textTransferEnabled) await this.textTransferStore.ensureDirectory();
    const removedStaleTransfers = await cleanupStaleSplitArchives(this.fileTransferTempRoot).catch((error) => {
      this.#log('file-transfer-cleanup-error', { error: error.message });
      return 0;
    });
    if (removedStaleTransfers > 0) this.#log('file-transfer-cleanup', { removed: removedStaleTransfers });
    this.infrastructureReady = this.#ensureInfrastructure();
    const infrastructure = await this.infrastructureReady;
    await infrastructure.guild.commands.set(commandPayload);
    const state = this.stateStore.snapshot();
    if (state.announcedVersion !== '2.0.0') {
      const embed = new EmbedBuilder()
        .setTitle('Codex Remote is ready')
        .setColor(COLORS.active)
        .setDescription([
          '全Codexタスクをプロジェクト別カテゴリへ自動同期します。',
          'アーカイブ済みタスクはCodex Archivedへ自動移動します。',
          '`/codex compose` でスマホから複数行指示',
          '`/codex status` で接続状態を確認',
          '',
          'タスクごとの非公開チャンネル、進捗表示、承認操作、切断復元が有効です。',
        ].join('\n'))
        .setFooter({ text: 'Codex Discord Remote 2.0.0' })
        .setTimestamp();
      await infrastructure.control.send({ embeds: [embed], allowedMentions: { parse: [] } });
      this.stateStore.update((value) => { value.announcedVersion = '2.0.0'; });
    }
    await this.#ensureControlPanel();
    this.#log('discord-ready', { user: this.client.user?.tag, guildId: this.config.guildId });
    this.#startTaskSyncPolling();
  }

  async #ensureInfrastructure() {
    const guild = await this.client.guilds.fetch(this.config.guildId);
    const channels = await guild.channels.fetch();
    const state = this.stateStore.snapshot();
    this.canPinControlPanels = guild.members.me?.permissions.has(PermissionFlagsBits.PinMessages) ?? false;
    const completionNotificationsAlreadyConfigured = Boolean(state.infrastructure.completionsChannelId);

    let controlCategory = state.infrastructure.controlCategoryId
      ? channels.get(state.infrastructure.controlCategoryId)
      : null;
    if (!controlCategory || controlCategory.type !== ChannelType.GuildCategory) {
      controlCategory = channels.find((channel) => channel?.type === ChannelType.GuildCategory
        && [this.config.controlCategoryName, 'Codex Remote'].includes(channel.name));
    }
    let controlCategoryCreated = false;
    if (!controlCategory) {
      controlCategory = await guild.channels.create({
        name: this.config.controlCategoryName,
        type: ChannelType.GuildCategory,
      });
      controlCategoryCreated = true;
    }
    if (controlCategory.name !== this.config.controlCategoryName) {
      await controlCategory.setName(this.config.controlCategoryName, 'Codex Remote 2.0 control-plane migration');
    }
    if (controlCategoryCreated) await this.#configurePrivateCategory(controlCategory, guild);

    const archiveCategories = (state.infrastructure.archiveCategoryIds ?? [])
      .map((categoryId) => channels.get(categoryId))
      .filter((channel) => channel?.type === ChannelType.GuildCategory);
    if (archiveCategories.length === 0) {
      const existingArchiveCategory = channels.find((channel) => channel?.type === ChannelType.GuildCategory
        && channel.name === this.config.archiveCategoryName);
      if (existingArchiveCategory) archiveCategories.push(existingArchiveCategory);
    }
    if (archiveCategories.length === 0) {
      const archiveCategory = await guild.channels.create({
        name: this.config.archiveCategoryName,
        type: ChannelType.GuildCategory,
      });
      await this.#copyCategoryPermissions(controlCategory, archiveCategory, guild);
      archiveCategories.push(archiveCategory);
    }

    let transferCategory = null;
    if (this.config.textTransferEnabled) {
      transferCategory = state.infrastructure.transferCategoryId
        ? channels.get(state.infrastructure.transferCategoryId)
        : null;
      if (!transferCategory || transferCategory.type !== ChannelType.GuildCategory) {
        transferCategory = channels.find((channel) => channel?.type === ChannelType.GuildCategory
          && channel.name === this.config.transferCategoryName);
      }
      let transferCategoryCreated = false;
      if (!transferCategory) {
        transferCategory = await guild.channels.create({
          name: this.config.transferCategoryName,
          type: ChannelType.GuildCategory,
        });
        transferCategoryCreated = true;
      }
      if (transferCategory.name !== this.config.transferCategoryName) {
        await transferCategory.setName(
          this.config.transferCategoryName,
          'Refresh the text-transfer category name',
        );
      }
      if (transferCategoryCreated) {
        await this.#copyCategoryPermissions(controlCategory, transferCategory, guild);
      }
    }

    const ensureTextChannel = async (storedId, name, topic, parentCategory = controlCategory) => {
      let channel = storedId ? channels.get(storedId) : null;
      if (!channel || channel.type !== ChannelType.GuildText) {
        channel = channels.find((candidate) => candidate?.type === ChannelType.GuildText
          && candidate.parentId === parentCategory.id && candidate.name === name);
      }
      if (!channel) {
        channel = await guild.channels.create({
          name,
          type: ChannelType.GuildText,
          parent: parentCategory.id,
          topic,
        });
      }
      if (channel.name !== name) await channel.setName(name, 'Codex Remote 2.0 control-plane migration');
      if (channel.parentId !== parentCategory.id) {
        await channel.setParent(parentCategory.id, { lockPermissions: true, reason: 'Move into the managed Discord category' });
      }
      if (channel.topic !== topic) await channel.setTopic(topic, 'Refresh Codex Remote control-plane metadata');
      if (!channel.permissionsLocked) await channel.lockPermissions();
      return channel;
    };

    const control = await ensureTextChannel(
      state.infrastructure.controlChannelId,
      this.config.controlChannelName,
      'Codex Remote control and task discovery',
    );
    const sync = await ensureTextChannel(
      state.infrastructure.syncChannelId,
      this.config.syncChannelName,
      'Codex automatic task synchronization activity',
    );
    const alerts = await ensureTextChannel(
      state.infrastructure.alertsChannelId,
      this.config.alertsChannelName,
      'Codex Remote connection and error notifications',
    );
    const completions = await ensureTextChannel(
      state.infrastructure.completionsChannelId,
      this.config.completionsChannelName,
      'Codex task completion notifications and links',
    );
    const transferText = transferCategory
      ? await ensureTextChannel(
        state.infrastructure.transferTextChannelId,
        this.config.transferTextChannelName,
        'Stores the latest authorized user or webhook message locally, then deletes the Discord source',
        transferCategory,
      )
      : null;
    this.transferTextChannelId = transferText?.id ?? null;
    this.stateStore.setInfrastructure({
      controlCategoryId: controlCategory.id,
      controlChannelId: control.id,
      syncChannelId: sync.id,
      alertsChannelId: alerts.id,
      completionsChannelId: completions.id,
      transferCategoryId: transferCategory?.id ?? null,
      transferTextChannelId: transferText?.id ?? null,
      archiveCategoryIds: archiveCategories.map((category) => category.id),
    });
    if (!completionNotificationsAlreadyConfigured) {
      this.stateStore.update((value) => {
        for (const binding of Object.values(value.bindings)) {
          binding.lastNotifiedCompletedTurnId = binding.lastCompletedTurnId ?? null;
        }
      });
    }
    return {
      guild, controlCategory, archiveCategories, transferCategory, control, sync, alerts, completions, transferText,
    };
  }

  #privateCategoryPermissions(guild, includePinMessages = false) {
    return [
      { id: guild.roles.everyone.id, type: OverwriteType.Role, deny: [PermissionFlagsBits.ViewChannel] },
      {
        id: this.client.user.id,
        type: OverwriteType.Member,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.EmbedLinks,
          PermissionFlagsBits.AttachFiles,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.ManageChannels,
          PermissionFlagsBits.ManageMessages,
          ...(includePinMessages ? [PermissionFlagsBits.PinMessages] : []),
        ],
      },
      ...this.authorizedUserIds.map((userId) => ({
        id: userId,
        type: OverwriteType.Member,
        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
      })),
    ];
  }

  async #configurePrivateCategory(category, guild) {
    const includePinMessages = guild.members.me?.permissions.has(PermissionFlagsBits.PinMessages) ?? false;
    await category.permissionOverwrites.set(
      this.#privateCategoryPermissions(guild, includePinMessages),
      'Restrict Codex Remote to the explicit allowlist',
    );
    this.canPinControlPanels = includePinMessages;
    if (!includePinMessages) {
      this.#log('pin-messages-permission-missing', {
        categoryId: category.id,
        note: 'Control panels remain available but cannot be pinned until the bot is reauthorized.',
      });
    }
  }

  async #copyCategoryPermissions(source, target, guild) {
    const overwrites = source?.permissionOverwrites?.cache
      ? [...source.permissionOverwrites.cache.values()].map((overwrite) => ({
        id: overwrite.id,
        type: overwrite.type,
        allow: overwrite.allow.bitfield,
        deny: overwrite.deny.bitfield,
      }))
      : [];
    if (overwrites.length === 0) {
      await this.#configurePrivateCategory(target, guild);
      return;
    }
    await target.permissionOverwrites.set(overwrites, 'Copy Codex Remote Discord permissions');
  }

  async #handleInteraction(interaction) {
    try {
      if (interaction.commandName === 'chatgpt' || String(interaction.customId ?? '').startsWith('cg:')) return;
      if (interaction.isAutocomplete()) {
        await this.#handleAutocomplete(interaction);
        return;
      }
      if (!this.#authorized(interaction)) return;
      if (interaction.isChatInputCommand() && interaction.commandName === 'codex') {
        await this.#handleCommand(interaction);
        return;
      }
      if (interaction.isChatInputCommand() && interaction.commandName === 'codex-files') {
        await this.#handleFilesCommand(interaction);
        return;
      }
      if (interaction.isStringSelectMenu()) {
        await this.#handleSelect(interaction);
        return;
      }
      if (interaction.isButton()) {
        await this.#handleButton(interaction);
        return;
      }
      if (interaction.isModalSubmit()) await this.#handleModal(interaction);
    } catch (error) {
      this.#log('interaction-error', { customId: interaction.customId, error: error.stack ?? error.message });
      const content = `失敗しました: ${truncate(error.message, 1800)}`;
      if (interaction.deferred) await interaction.editReply(messageOptions(content, { components: [] })).catch(() => {});
      else if (interaction.replied) await interaction.followUp(messageOptions(content, { ephemeral: true })).catch(() => {});
      else await interaction.reply(messageOptions(content, { ephemeral: true })).catch(() => {});
    }
  }

  #queueDiscordMessage(message) {
    const channelId = message.channelId ?? '__unknown__';
    const previous = this.discordMessageQueues.get(channelId) ?? Promise.resolve();
    const queued = previous
      .then(() => this.#handleDiscordMessage(message))
      .catch((error) => {
        this.#log('plain-message-handler-error', {
          messageId: message.id,
          channelId: message.channelId,
          userId: message.author?.id,
          error: error.stack ?? error.message,
        });
      });
    this.discordMessageQueues.set(channelId, queued);
    queued.finally(() => {
      if (this.discordMessageQueues.get(channelId) === queued) this.discordMessageQueues.delete(channelId);
    });
  }

  #managedProjectForChannel(channel) {
    if (channel?.type !== ChannelType.GuildText || !channel.parentId) return null;
    return this.stateStore.projectCategories()
      .find((project) => !this.#isProjectHidden(project.projectKey)
        && (project.categoryIds ?? []).includes(channel.parentId)) ?? null;
  }

  async #createTaskBinding(channel, project) {
    const existing = this.stateStore.bindingByChannel(channel.id);
    if (existing) return existing;

    // A sync that already listed tasks must finish before the new task exists.
    if (this.taskSyncPromise) await this.taskSyncPromise;

    const cwd = project.path === '(no project)' ? null : project.path;
    const started = await this.codex.startThread(cwd);
    const thread = started.thread;
    if (!thread?.id) throw new Error('Codex did not return a task ID for the new task.');

    // Bind immediately so lifecycle synchronization cannot create a second channel.
    await this.#bindChannel(thread, channel, {
      archived: false,
      categoryId: channel.parentId,
      projectKey: project.projectKey,
      projectId: project.projectId,
      subscribe: false,
    });

    const title = taskTitleFromChannelName(channel.name);
    await this.codex.setThreadName(thread.id, title);
    const namedThread = { ...thread, name: title };
    this.stateStore.setBinding(thread.id, { name: title, cwd: thread.cwd ?? cwd });

    const desiredName = taskChannelName(namedThread);
    if (channel.name !== desiredName) {
      await this.#setTaskChannelName(channel, desiredName, 'Bind Discord channel to a new Codex task');
    }
    const desiredTopic = truncate(
      `Codex project: ${project.projectId}\nCodex task: ${thread.id}\nProject: ${thread.cwd ?? cwd ?? '(none)'}\nState: active\nTurn: stopped`,
      1024,
      '',
    );
    if (channel.topic !== desiredTopic) await channel.setTopic(desiredTopic, 'Bind Discord channel to a new Codex task');
    if (!channel.permissionsLocked) await channel.lockPermissions();

    this.#log('discord-channel-created-task', {
      channelId: channel.id,
      categoryId: channel.parentId,
      projectId: project.projectId,
      threadId: thread.id,
      cwd,
      title,
    });
    this.#scheduleTaskSync('discord-channel-created-task');
    return this.stateStore.binding(thread.id);
  }

  async #ensureTaskBinding(channel, project) {
    const existing = this.stateStore.bindingByChannel(channel.id);
    if (existing) return existing;
    const pending = this.pendingChannelBindings.get(channel.id);
    if (pending) return pending;

    const creation = this.#createTaskBinding(channel, project);
    this.pendingChannelBindings.set(channel.id, creation);
    try {
      return await creation;
    } finally {
      if (this.pendingChannelBindings.get(channel.id) === creation) {
        this.pendingChannelBindings.delete(channel.id);
      }
    }
  }

  async #handleDiscordMessage(message) {
    if (message.guildId !== this.config.guildId) return;
    const controlChannelId = this.stateStore.snapshot?.().infrastructure?.controlChannelId ?? null;
    if (message.channelId === controlChannelId) {
      if (this.#panelMarker(message) !== CONTROL_PANEL_MARKER) await this.#ensureControlPanel();
      return;
    }
    if (this.config.textTransferEnabled && message.channelId === this.transferTextChannelId) {
      await this.#handleTransferTextMessage(message);
      return;
    }
    if (!this.config.plainMessageInputEnabled || message.author.bot || message.webhookId) return;
    let binding = this.stateStore.bindingByChannel(message.channelId);
    let channel = null;
    let project = null;
    if (!binding) {
      channel = message.channel ?? await this.client.channels.fetch(message.channelId).catch(() => null);
      project = this.#managedProjectForChannel(channel);
      if (!project) return;
    }
    const canExecuteTask = binding && this.#hasMessageExecutionPermission(message);
    const canCreateTask = !binding && this.#isAuthorizedUser(message.author.id);
    if (!canExecuteTask && !canCreateTask) {
      this.#log('unauthorized-message', {
        guildId: message.guildId,
        channelId: message.channelId,
        messageId: message.id,
        userId: message.author.id,
      });
      await message.reply(messageOptions(
        '拒否しました。このBotへのプロンプトとコマンドは、設定済みの1ユーザーだけが実行できます。',
      )).catch(() => {});
      return;
    }

    const content = message.content.trim();
    const attachments = [...message.attachments.values()];
    if (!content && attachments.length === 0) return;

    await message.react('⏳').catch(() => {});
    const prompt = content || ATTACHMENT_ONLY_PROMPT;
    let reservation = null;
    try {
      if (!binding) binding = await this.#ensureTaskBinding(channel, project);
      if (!binding) throw new Error('Discord channel could not be bound to the new Codex task.');
      const preparedAttachments = await this.#prepareAttachments(
        attachments,
        binding.threadId,
        message.id,
      );
      reservation = this.#reserveUserInput(
        binding.threadId,
        prompt,
        `Discord: ${message.author.tag}`,
        {
          executorUserId: message.author.id,
          alreadyVisible: true,
          visibleMessageId: message.id,
        },
      );
      const result = await this.codex.deliver(
        binding.threadId,
        prompt,
        preparedAttachments,
        reservation.clientUserMessageId,
      );
      reservation.turnId ??= result.turnId;
      await this.#ensureReservedUserInputPosted(reservation);
      await this.#moveLiveCardAfterReservedInput(reservation);
      await message.react('✅').catch(() => {});
      this.#log('plain-message-delivered', {
        messageId: message.id,
        channelId: message.channelId,
        threadId: binding.threadId,
        userId: message.author.id,
        mode: result.mode,
        turnId: result.turnId,
        attachments: preparedAttachments.map((attachment) => attachment.kind),
      });
    } catch (error) {
      if (reservation) this.#removeUserInputReservation(reservation);
      await message.react('❌').catch(() => {});
      await message.reply(messageOptions(`Codexへの指示送信に失敗しました: ${truncate(error.message, 1700)}`)).catch(() => {});
      throw error;
    } finally {
      const pendingReaction = message.reactions.resolve('⏳');
      await pendingReaction?.users.remove(this.client.user.id).catch(() => {});
    }
  }

  async #handleTransferTextMessage(message) {
    const isWebhook = Boolean(message.webhookId);
    const isAuthorizedUser = !message.author?.bot && this.#isAuthorizedUser(message.author?.id);
    if (!isWebhook && !isAuthorizedUser) {
      if (!message.author?.bot) {
        this.#log('unauthorized-transfer-text-message', {
          guildId: message.guildId,
          channelId: message.channelId,
          messageId: message.id,
          userId: message.author?.id ?? null,
        });
        await message.reply(messageOptions(
          '拒否しました。このチャンネルへテキストを配置できるのは、設定済みの認証ユーザーまたはWebhookだけです。',
        )).catch(() => {});
      }
      return;
    }

    const content = String(message.content ?? '');
    if (content.length === 0) {
      this.#log('empty-transfer-text-message', {
        channelId: message.channelId,
        messageId: message.id,
        webhookId: message.webhookId ?? null,
      });
      await message.react('⚠️').catch(() => {});
      return;
    }

    let stored;
    try {
      stored = await this.textTransferStore.store(content, message.createdTimestamp);
    } catch (error) {
      await message.react('❌').catch(() => {});
      await this.#postAlert(
        `transfer-textのローカル保存に失敗しました: ${message.id}\n${truncate(error.message, 1700)}`,
        'error',
      ).catch(() => {});
      throw error;
    }

    try {
      await message.delete();
    } catch (error) {
      if (error.code !== 10008) {
        await message.react('❌').catch(() => {});
        await this.#postAlert(
          `transfer-textはローカル保存済みですが、Discordメッセージの削除に失敗しました: ${message.id}\n${truncate(error.message, 1700)}`,
          'error',
        ).catch(() => {});
        throw error;
      }
    }

    this.#log('transfer-text-stored', {
      channelId: message.channelId,
      messageId: message.id,
      userId: isWebhook ? null : message.author.id,
      webhookId: message.webhookId ?? null,
      filename: stored.filename,
      path: stored.path,
      bytes: stored.bytes,
      sourceMessageDeleted: true,
    });
  }

  async #handleChannelUpdate(oldChannel, newChannel) {
    if (newChannel.guildId !== this.config.guildId || newChannel.type !== ChannelType.GuildText) return;
    const parentChanged = oldChannel.parentId !== newChannel.parentId;
    let nameChanged = oldChannel.name !== newChannel.name;
    if (!parentChanged && !nameChanged) return;

    if (nameChanged) {
      const internalName = this.internalChannelNames.get(newChannel.id);
      if (internalName) {
        this.internalChannelNames.delete(newChannel.id);
        if (internalName === newChannel.name) nameChanged = false;
      }
    }

    const binding = this.stateStore.bindingByChannel(newChannel.id);
    if (!binding) return;
    if (nameChanged) await this.#handleTaskChannelRename(binding, newChannel);
    if (!parentChanged) return;

    const internalTarget = this.internalChannelMoves.get(newChannel.id);
    if (internalTarget) {
      this.internalChannelMoves.delete(newChannel.id);
      if (internalTarget === newChannel.parentId) return;
    }

    const state = this.stateStore.snapshot();
    const archiveCategoryIds = new Set(state.infrastructure.archiveCategoryIds ?? []);
    const projectCategoryIds = new Set(
      binding.projectKey ? state.projectCategories?.[binding.projectKey]?.categoryIds ?? [] : [],
    );

    if (archiveCategoryIds.has(newChannel.parentId)) {
      if (binding.archived) {
        this.stateStore.setBinding(binding.threadId, { categoryId: newChannel.parentId });
        return;
      }
      await this.codex.archiveThread(binding.threadId);
      await this.codex.unsubscribeThread(binding.threadId);
      this.stateStore.setBinding(binding.threadId, {
        archived: true,
        categoryId: newChannel.parentId,
      });
      this.#log('discord-channel-archived-task', {
        threadId: binding.threadId,
        channelId: newChannel.id,
        categoryId: newChannel.parentId,
      });
      this.#scheduleTaskSync('discord-channel-archived-task');
      return;
    }

    if (projectCategoryIds.has(newChannel.parentId)) {
      if (!binding.archived) {
        this.stateStore.setBinding(binding.threadId, { categoryId: newChannel.parentId });
        return;
      }
      await this.codex.unarchiveThread(binding.threadId);
      await this.codex.resumeThread(binding.threadId);
      this.stateStore.setBinding(binding.threadId, {
        archived: false,
        categoryId: newChannel.parentId,
      });
      this.#log('discord-channel-unarchived-task', {
        threadId: binding.threadId,
        channelId: newChannel.id,
        categoryId: newChannel.parentId,
      });
      this.#scheduleTaskSync('discord-channel-unarchived-task');
      return;
    }

    const rollbackCategoryId = binding.categoryId ?? oldChannel.parentId;
    if (!rollbackCategoryId || rollbackCategoryId === newChannel.parentId) return;
    await this.#moveTaskChannel(
      newChannel,
      rollbackCategoryId,
      'Reject moving a Codex task outside its project or archive categories',
    );
    this.#log('discord-channel-category-rolled-back', {
      threadId: binding.threadId,
      channelId: newChannel.id,
      rejectedCategoryId: newChannel.parentId,
      restoredCategoryId: rollbackCategoryId,
    });
  }

  async #handleTaskChannelRename(binding, channel) {
    const title = taskTitleFromChannelName(channel.name);
    if (title === binding.name) {
      this.#scheduleTaskSync('discord-channel-status-prefix-removed');
      return;
    }
    await this.codex.setThreadName(binding.threadId, title);
    this.stateStore.setBinding(binding.threadId, { name: title });
    this.#log('discord-channel-renamed-task', {
      threadId: binding.threadId,
      channelId: channel.id,
      title,
    });
    this.#scheduleTaskSync('discord-channel-renamed-task');
  }

  async #setTaskChannelName(channel, name, reason) {
    this.internalChannelNames.set(channel.id, name);
    try {
      await channel.setName(name, reason);
    } catch (error) {
      if (this.internalChannelNames.get(channel.id) === name) this.internalChannelNames.delete(channel.id);
      throw error;
    }
    const cleanupTimer = setTimeout(() => {
      if (this.internalChannelNames.get(channel.id) === name) this.internalChannelNames.delete(channel.id);
    }, 10_000);
    cleanupTimer.unref?.();
  }

  async #applyTaskChannelMetadata({ channel, name, topic, reason }) {
    const nameChanged = channel.name !== name;
    if (nameChanged) this.internalChannelNames.set(channel.id, name);
    try {
      if (typeof channel.edit === 'function') {
        await channel.edit({ name, topic }, reason);
      } else {
        if (nameChanged) await channel.setName(name, reason);
        if (channel.topic !== topic) await channel.setTopic(topic, reason);
      }
      this.#log('task-channel-metadata-updated', { channelId: channel.id, name });
    } catch (error) {
      if (nameChanged && this.internalChannelNames.get(channel.id) === name) {
        this.internalChannelNames.delete(channel.id);
      }
      throw error;
    }
    if (nameChanged) {
      const cleanupTimer = setTimeout(() => {
        if (this.internalChannelNames.get(channel.id) === name) this.internalChannelNames.delete(channel.id);
      }, 10_000);
      cleanupTimer.unref?.();
    }
  }

  #scheduleTaskChannelMetadata(channel, name, topic, reason) {
    this.taskChannelMetadataUpdates.schedule(channel.id, {
      channel,
      name,
      topic,
      reason,
    });
  }

  async #moveTaskChannel(channel, parentId, reason) {
    this.internalChannelMoves.set(channel.id, parentId);
    try {
      await channel.setParent(parentId, { lockPermissions: true, reason });
    } catch (error) {
      if (this.internalChannelMoves.get(channel.id) === parentId) {
        this.internalChannelMoves.delete(channel.id);
      }
      throw error;
    }
    const cleanupTimer = setTimeout(() => {
      if (this.internalChannelMoves.get(channel.id) === parentId) {
        this.internalChannelMoves.delete(channel.id);
      }
    }, 10_000);
    cleanupTimer.unref?.();
  }

  #authorized(interaction) {
    const taskBinding = this.stateStore.bindingByChannel?.(interaction.channelId) ?? null;
    const hasTaskPermission = Boolean(taskBinding)
      && this.#hasDiscordExecutionPermission(interaction.memberPermissions);
    const allowed = interaction.guildId === this.config.guildId
      && (this.#isAuthorizedUser(interaction.user.id) || hasTaskPermission);
    if (!allowed) {
      this.#log('unauthorized-interaction', {
        guildId: interaction.guildId,
        userId: interaction.user?.id,
        command: interaction.commandName,
      });
      if (interaction.isRepliable()) {
        interaction.reply(messageOptions(
          '拒否しました。このBotへのプロンプトとコマンドは、設定済みの1ユーザーだけが実行できます。',
          { ephemeral: true },
        )).catch(() => {});
      }
    }
    return allowed;
  }

  #isAuthorizedUser(userId) {
    return this.authorizedUserIds.includes(userId);
  }

  #hasDiscordExecutionPermission(permissions) {
    return Boolean(permissions?.has?.(PermissionFlagsBits.ViewChannel)
      && permissions.has(PermissionFlagsBits.SendMessages));
  }

  #hasMessageExecutionPermission(message) {
    if (this.#isAuthorizedUser(message.author?.id)) return true;
    const permissions = message.memberPermissions
      ?? message.member?.permissionsIn?.(message.channel)
      ?? message.channel?.permissionsFor?.(message.member ?? message.author);
    return this.#hasDiscordExecutionPermission(permissions);
  }

  async #handleAutocomplete(interaction) {
    if (!this.#authorized(interaction) || !this.codex.connected) {
      await interaction.respond([]).catch(() => {});
      return;
    }
    const focused = interaction.options.getFocused(true);
    const query = focused.value.trim();
    if (focused.name === 'model') {
      const models = await this.codex.listModels();
      const choices = models
        .filter((model) => !model.hidden && (!query
          || model.model.toLowerCase().includes(query.toLowerCase())
          || model.displayName.toLowerCase().includes(query.toLowerCase())))
        .slice(0, 25)
        .map((model) => ({
          name: truncate(`${model.displayName} - ${model.description}`, 100, ''),
          value: model.model,
        }));
      await interaction.respond(choices);
      return;
    }
    if (focused.name === 'profile') {
      const threadId = interaction.options.getString('task')
        ?? this.stateStore.bindingByChannel(interaction.channelId)?.threadId
        ?? null;
      if (threadId) this.#assertThreadAccess(interaction, threadId);
      const cwd = threadId ? this.stateStore.binding(threadId)?.cwd : null;
      const profiles = await this.codex.listPermissionProfiles(cwd);
      const choices = profiles
        .filter((profile) => profile.allowed && (!query || profile.id.toLowerCase().includes(query.toLowerCase())))
        .slice(0, 25)
        .map((profile) => ({
          name: truncate(`${profile.id}${profile.description ? ` - ${profile.description}` : ''}`, 100, ''),
          value: profile.id,
        }));
      await interaction.respond(choices);
      return;
    }
    const result = await this.codex.listThreads({ limit: 20, search: query || null });
    const desktopProjects = readDesktopProjectSnapshot(this.config.desktopGlobalStatePath);
    const channelThreadId = this.stateStore.bindingByChannel?.(interaction.channelId)?.threadId ?? null;
    const projectVisibleThreads = result.data.filter((thread) => {
      const descriptor = projectDescriptorForThread(
        thread,
        desktopProjects,
        this.config.projectCategoryPrefix,
      );
      return !this.#hiddenProjectDescriptorForThread(thread, descriptor);
    });
    const visibleThreads = this.#isAuthorizedUser(interaction.user.id)
      ? projectVisibleThreads
      : projectVisibleThreads.filter((thread) => thread.id === channelThreadId);
    const choices = visibleThreads.slice(0, 25).map((thread) => ({
      name: truncate(`${threadStatusEmoji(thread.status)} ${thread.name ?? thread.preview ?? thread.id}`, 100, ''),
      value: thread.id,
    }));
    await interaction.respond(choices);
  }

  async #statusEmbed() {
    const health = await this.codex.health();
    const codex = this.codex.status();
    const bindings = this.stateStore.bindings();
    const projects = this.#projectVisibilityProjects();
    return new EmbedBuilder()
      .setTitle('Codex Remote status')
      .setColor(codex.connected ? COLORS.active : COLORS.error)
      .addFields(
        { name: 'Discord', value: `connected as ${this.client.user.tag}`, inline: true },
        { name: 'app-server', value: codex.connected ? 'connected' : 'offline/retrying', inline: true },
        { name: 'readyz', value: `${health.ready} (${health.status})`, inline: true },
        { name: 'Endpoint', value: `\`${health.endpoint}\`\nsource: ${health.source}` },
        { name: 'Active tasks', value: String(bindings.filter((binding) => !binding.archived).length), inline: true },
        { name: 'Archived tasks', value: String(bindings.filter((binding) => binding.archived).length), inline: true },
        { name: 'Visible projects', value: String(projects.filter((project) => !project.hidden).length), inline: true },
        { name: 'Hidden projects', value: String(projects.filter((project) => project.hidden).length), inline: true },
        { name: 'Pending requests', value: String(this.#visiblePendingRequestCount()), inline: true },
      )
      .setTimestamp();
  }

  #hiddenProjects() {
    if (typeof this.stateStore.hiddenProjects === 'function') return this.stateStore.hiddenProjects();
    return Object.entries(this.stateStore.snapshot?.().hiddenProjects ?? {})
      .map(([projectKey, value]) => ({ projectKey, ...value }));
  }

  #isProjectHidden(projectKey) {
    if (!projectKey) return false;
    if (typeof this.stateStore.isProjectHidden === 'function') {
      return this.stateStore.isProjectHidden(projectKey);
    }
    return Boolean(this.stateStore.snapshot?.().hiddenProjects?.[projectKey]);
  }

  #isBindingHidden(binding) {
    return Boolean(binding?.hidden || this.#isProjectHidden(binding?.projectKey));
  }

  #hiddenProjectDescriptorForThread(thread, descriptor) {
    if (this.#isProjectHidden(descriptor?.key)) return descriptor;
    const binding = this.stateStore.binding?.(thread?.id);
    if (!binding?.projectKey || !this.#isProjectHidden(binding.projectKey)) return null;
    const hiddenProject = this.stateStore.hiddenProject?.(binding.projectKey) ?? null;
    return {
      ...descriptor,
      id: binding.projectId ?? hiddenProject?.projectId ?? binding.projectKey,
      key: binding.projectKey,
      path: hiddenProject?.path ?? binding.cwd ?? thread?.cwd ?? descriptor?.path ?? '(no project)',
      name: hiddenProject?.name ?? descriptor?.name ?? this.config.projectCategoryPrefix,
    };
  }

  #projectVisibilityProjects() {
    const bindings = typeof this.stateStore.bindings === 'function'
      ? this.stateStore.bindings({ includeHidden: true })
      : [];
    return projectVisibilityCatalog({
      projectCategories: this.stateStore.projectCategories?.() ?? [],
      hiddenProjects: this.#hiddenProjects(),
      bindings,
      categoryPrefix: this.config.projectCategoryPrefix,
    });
  }

  #projectVisibilitySession(key, userId) {
    const session = this.pendingActions.get(key);
    if (!session || session.userId !== userId || session.type !== 'projectVisibility') {
      throw new Error('プロジェクト表示画面は期限切れです。もう一度開いてください。');
    }
    if (Date.now() - session.createdAt > 30 * 60_000) {
      this.pendingActions.delete(key);
      throw new Error('プロジェクト表示画面は期限切れです。もう一度開いてください。');
    }
    return session;
  }

  #refreshProjectVisibilitySession(session) {
    session.projects = this.#projectVisibilityProjects();
    const pageCount = Math.max(1, Math.ceil(session.projects.length / 25));
    session.page = Math.min(Math.max(0, session.page ?? 0), pageCount - 1);
    session.createdAt = Date.now();
    return session;
  }

  async #showProjectVisibility(interaction) {
    const key = randomKey();
    const session = this.#refreshProjectVisibilitySession({
      type: 'projectVisibility',
      key,
      userId: interaction.user.id,
      projects: [],
      page: 0,
      createdAt: Date.now(),
    });
    this.pendingActions.set(key, session);
    await interaction.reply({
      ...projectVisibilityPayload(session),
      ephemeral: true,
    });
  }

  #assertThreadVisible(thread) {
    const desktopProjects = readDesktopProjectSnapshot(this.config.desktopGlobalStatePath);
    const descriptor = projectDescriptorForThread(
      thread,
      desktopProjects,
      this.config.projectCategoryPrefix,
    );
    if (this.#hiddenProjectDescriptorForThread(thread, descriptor)) {
      throw new Error('このプロジェクトはDiscordで非表示です。Codex Remoteの「プロジェクト表示」から再表示してください。');
    }
  }

  #pendingContent(threadId = null) {
    const records = [...this.pendingRequests.values()]
      .filter((record) => !this.#isBindingHidden(this.stateStore.binding?.(record.threadId)))
      .filter((record) => !threadId || record.threadId === threadId);
    return records.length
      ? records.map((record) => `- ${record.method} / task \`${record.threadId}\` / ${channelMention(record.channelId)}`).join('\n')
      : '未回答の承認・入力要求はありません。';
  }

  #visiblePendingRequestCount() {
    return [...this.pendingRequests.values()]
      .filter((record) => !this.#isBindingHidden(this.stateStore.binding?.(record.threadId)))
      .length;
  }

  #syncResultText(result) {
    return `全タスクを同期しました。未アーカイブ ${result.active} / アーカイブ ${result.archived} / 非表示 ${result.hidden ?? 0} / 新規 ${result.created} / 移動 ${result.moved} / Discord削除 ${result.deleted ?? 0} / 失敗 ${result.failed}`;
  }

  async #showComposeModal(interaction, threadId, mode) {
    if (!['deliver', 'send', 'steer'].includes(mode)) throw new Error(`Unknown delivery mode: ${mode}`);
    const key = randomKey();
    this.pendingActions.set(key, { type: 'compose', userId: interaction.user.id, threadId, mode, createdAt: Date.now() });
    const modal = new ModalBuilder().setCustomId(`cx:compose:${key}`).setTitle(`Codex ${mode}`)
      .addComponents(userInputField('prompt', 'Codexへの指示'));
    await interaction.showModal(modal);
  }

  async #showInterruptConfirmation(interaction, threadId) {
    const currentTurn = await this.codex.activeTurn(threadId);
    if (!currentTurn) throw new Error('現在稼働中のターンはありません。');
    const key = randomKey();
    this.pendingActions.set(key, {
      type: 'interrupt', userId: interaction.user.id, threadId, turnId: currentTurn.id, createdAt: Date.now(),
    });
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`cx:interrupt:${key}:yes`).setLabel('中断する').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`cx:interrupt:${key}:no`).setLabel('戻る').setStyle(ButtonStyle.Secondary),
    );
    await interaction.reply(messageOptions(
      `ターン \`${currentTurn.id}\` を中断しますか？プロセスkillではなくapp-serverの \`turn/interrupt\` を使います。`,
      { components: [row], ephemeral: true },
    ));
  }

  #assertControlPanelInteraction(interaction) {
    const controlChannelId = this.stateStore.snapshot().infrastructure.controlChannelId;
    if (interaction.channelId !== controlChannelId) throw new Error('この操作はCodex制御チャンネルでのみ利用できます。');
  }

  #assertTaskPanelInteraction(interaction, threadId) {
    const binding = this.stateStore.binding(threadId);
    if (!binding || binding.channelId !== interaction.channelId) {
      throw new Error('この操作パネルは現在のタスクチャンネルに紐付いていません。');
    }
    return binding;
  }

  #threadFromBinding(binding) {
    return {
      id: binding.threadId,
      name: binding.name,
      cwd: binding.cwd,
      status: { type: binding.taskStatus ?? 'unknown' },
      turns: [],
    };
  }

  #runtimeSettingsFromResume(runtime, existing = {}) {
    return {
      ...existing,
      model: runtime?.model ?? existing.model ?? null,
      effort: runtime?.reasoningEffort ?? existing.effort ?? null,
      serviceTier: runtime?.serviceTier ?? existing.serviceTier ?? null,
      approvalPolicy: runtime?.approvalPolicy ?? existing.approvalPolicy ?? null,
      approvalsReviewer: runtime?.approvalsReviewer ?? existing.approvalsReviewer ?? null,
      sandbox: runtime?.sandbox ?? existing.sandbox ?? null,
      activePermissionProfile: runtime?.activePermissionProfile ?? existing.activePermissionProfile ?? null,
    };
  }

  #persistRuntime(threadId, runtime) {
    const binding = this.stateStore.binding(threadId);
    if (!binding) return;
    const workspaceRoots = runtime.workspaceRoots
      ?? runtime.workspace_roots
      ?? runtime.workspace?.roots
      ?? null;
    const runtimeWorkspaceRoots = Array.isArray(workspaceRoots)
      ? workspaceRoots.map((value) => typeof value === 'string' ? value : value?.path).filter(Boolean)
      : binding.runtimeWorkspaceRoots ?? [];
    this.stateStore.setBinding(threadId, {
      runtimeSettings: this.#runtimeSettingsFromResume(runtime, binding.runtimeSettings),
      runtimeWorkspaceRoots,
      cwd: runtime.cwd ?? binding.cwd,
      name: runtime.thread?.name ?? binding.name,
      taskStatus: runtime.thread?.status?.type ?? binding.taskStatus,
    });
  }

  async #controlContext(threadId) {
    const runtime = await this.codex.resumeThread(threadId);
    let binding = this.stateStore.binding(threadId);
    if (!binding) {
      await this.#openTaskChannel(runtime.thread);
      binding = this.stateStore.binding(threadId);
    }
    if (!binding) throw new Error('タスクのDiscord bindingを作成できませんでした。');
    this.#persistRuntime(threadId, runtime);
    binding = this.stateStore.binding(threadId);
    const [models, profiles, modes, goalResult, terminals] = await Promise.all([
      this.codex.listModels(),
      this.codex.listPermissionProfiles(runtime.cwd ?? binding.cwd),
      this.codex.listCollaborationModes(),
      this.codex.getGoal(threadId),
      this.codex.listBackgroundTerminals(threadId),
    ]);
    return {
      thread: runtime.thread,
      binding,
      runtime,
      models,
      profiles,
      modes,
      goal: goalResult.goal ?? null,
      terminals,
    };
  }

  async #showTaskControls(interaction, threadId) {
    const context = await this.#controlContext(threadId);
    await interaction.editReply(taskControlPayload(context));
  }

  async #showTaskStatus(interaction, threadId) {
    const context = await this.#controlContext(threadId);
    const activeTurn = await this.codex.activeTurn(threadId);
    await interaction.editReply({ embeds: [taskStatusEmbed({ ...context, activeTurn })], components: [] });
  }

  async #applyThreadSettings(threadId, patch) {
    await this.codex.updateThreadSettings(threadId, patch);
    const binding = this.stateStore.binding(threadId);
    if (!binding) return;
    const stored = { ...binding.runtimeSettings };
    if (Object.hasOwn(patch, 'model')) stored.model = patch.model;
    if (Object.hasOwn(patch, 'effort')) stored.effort = patch.effort;
    if (Object.hasOwn(patch, 'serviceTier')) stored.serviceTier = patch.serviceTier;
    if (Object.hasOwn(patch, 'collaborationMode')) stored.collaborationMode = patch.collaborationMode;
    if (Object.hasOwn(patch, 'personality')) stored.personality = patch.personality;
    if (Object.hasOwn(patch, 'permissions')) stored.activePermissionProfile = { id: patch.permissions, extends: null };
    this.stateStore.setBinding(threadId, { runtimeSettings: stored });
  }

  async #applyCollaborationMode(threadId, modeKind) {
    const [runtime, modes] = await Promise.all([
      this.codex.resumeThread(threadId),
      this.codex.listCollaborationModes(),
    ]);
    const preset = modes.find((mode) => mode.mode === modeKind);
    if (!preset) throw new Error(`app-serverがcollaboration mode ${modeKind} を提供していません。`);
    const collaborationMode = {
      mode: modeKind,
      settings: {
        model: preset.model ?? runtime.model,
        reasoning_effort: preset.reasoning_effort ?? null,
        developer_instructions: null,
      },
    };
    await this.#applyThreadSettings(threadId, { collaborationMode });
    return collaborationMode;
  }

  async #accountUsageResponse() {
    const [usage, rateLimits] = await Promise.all([
      this.codex.accountUsage(),
      this.codex.accountRateLimits(),
    ]);
    return accountUsageEmbed({ usage, rateLimits });
  }

  #resourceCwds(threadId = null) {
    if (threadId) {
      const cwd = this.stateStore.binding(threadId)?.cwd;
      return cwd ? [cwd] : [];
    }
    return [...new Set(this.stateStore.bindings().map((binding) => binding.cwd).filter(Boolean))];
  }

  async #resourceResponse(kind, threadId = null) {
    const cwds = this.#resourceCwds(threadId);
    let result;
    if (kind === 'mcp') result = await this.codex.listMcpServers(threadId);
    else if (kind === 'skills') result = await this.codex.listSkills(cwds);
    else if (kind === 'plugins') result = await this.codex.listPlugins(cwds);
    else if (kind === 'hooks') result = await this.codex.listHooks(cwds);
    else if (kind === 'features') result = await this.codex.listExperimentalFeatures(threadId);
    else throw new Error(`Unknown resource kind: ${kind}`);
    return resourceInventoryEmbed(kind, result);
  }

  #reviewTarget(kind, value = null) {
    if (kind === 'uncommitted') return { type: 'uncommittedChanges' };
    if (!value?.trim()) throw new Error(`${kind} reviewにはvalueが必要です。`);
    if (kind === 'base') return { type: 'baseBranch', branch: value.trim() };
    if (kind === 'commit') return { type: 'commit', sha: value.trim(), title: null };
    if (kind === 'custom') return { type: 'custom', instructions: value.trim() };
    throw new Error(`Unknown review target: ${kind}`);
  }

  async #startReview(threadId, kind, value, delivery) {
    const result = await this.codex.startReview(threadId, this.#reviewTarget(kind, value), delivery);
    let channel = null;
    if (delivery === 'detached' && result.reviewThreadId !== threadId) {
      const reviewThread = await this.codex.threadMetadata(result.reviewThreadId);
      channel = await this.#openTaskChannel(reviewThread.thread);
    }
    return {
      ...result,
      channel,
      text: channel
        ? `レビューを新しいタスクで開始しました: ${channelMention(channel.id)} / turn \`${result.turn?.id ?? 'pending'}\``
        : `レビューを開始しました: turn \`${result.turn?.id ?? 'pending'}\``,
    };
  }

  async #showConfirmation(
    interaction,
    action,
    description,
    confirmLabel,
    confirmStyle = ButtonStyle.Danger,
  ) {
    const key = randomKey();
    this.pendingActions.set(key, {
      ...action,
      userId: interaction.user.id,
      createdAt: Date.now(),
    });
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`cx:confirm:${key}:yes`).setLabel(confirmLabel).setStyle(confirmStyle),
      new ButtonBuilder().setCustomId(`cx:confirm:${key}:no`).setLabel('戻る').setStyle(ButtonStyle.Secondary),
    );
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(messageOptions(description, { components: [row] }));
    } else {
      await interaction.reply(messageOptions(description, { components: [row], ephemeral: true }));
    }
  }

  async #showGoalModal(interaction, threadId) {
    const key = randomKey();
    this.pendingActions.set(key, { type: 'goalset', userId: interaction.user.id, threadId, createdAt: Date.now() });
    const budget = new TextInputBuilder()
      .setCustomId('budget')
      .setLabel('Token budget (optional)')
      .setStyle(TextInputStyle.Short)
      .setRequired(false)
      .setMaxLength(12);
    const modal = new ModalBuilder()
      .setCustomId(`cx:goal:${key}`)
      .setTitle('Codex goal')
      .addComponents(
        userInputField('objective', 'Goal objective'),
        new ActionRowBuilder().addComponents(budget),
      );
    await interaction.showModal(modal);
  }

  async #showReviewModal(interaction, threadId, kind, delivery) {
    const key = randomKey();
    this.pendingActions.set(key, {
      type: 'review', userId: interaction.user.id, threadId, kind, delivery, createdAt: Date.now(),
    });
    const labels = { base: 'Base branch', commit: 'Commit SHA', custom: 'Review instructions' };
    const modal = new ModalBuilder()
      .setCustomId(`cx:review:${key}`)
      .setTitle('Codex review')
      .addComponents(userInputField('value', labels[kind] ?? 'Review target'));
    await interaction.showModal(modal);
  }

  #assertFileSharingEnabled() {
    if (this.config.fileShareEnabled === false) throw new Error('ローカルファイル共有は設定で無効です。');
  }

  async #allowedFileRoots(binding, { includeSiblingProjects = false } = {}) {
    const projectRoots = typeof this.stateStore.projectCategories === 'function'
      ? this.stateStore.projectCategories().map((project) => project.path)
      : [];
    const sessionWorkspaceRoots = await readSessionWorkspaceRoots(
      binding?.sessionPath,
      binding?.threadId,
    );
    const codexHome = this.config.desktopGlobalStatePath
      ? path.win32.dirname(this.config.desktopGlobalStatePath)
      : null;
    const generatedImageRoot = codexHome && binding?.threadId
      ? path.win32.join(codexHome, 'generated_images', binding.threadId)
      : null;
    const taskArtifactRoots = generatedImageRoot
      && isTaskScopedCodexArtifactRoot(generatedImageRoot, binding?.threadId, codexHome)
      ? [generatedImageRoot]
      : [];
    const workspaceRoots = [
      ...(binding?.runtimeWorkspaceRoots ?? []),
      ...sessionWorkspaceRoots,
      ...taskArtifactRoots,
    ].map((rootPath) => ({
      path: rootPath,
      allowProtectedAncestors: isTaskScopedCodexArtifactRoot(
        rootPath,
        binding?.threadId,
        codexHome,
      ),
    }));
    const roots = [
      binding?.cwd,
      ...workspaceRoots,
      ...projectRoots,
    ].filter((value) => value && value !== '(no project)' && value.path !== '(no project)');
    if (includeSiblingProjects) {
      const distinctProjects = [...new Map([binding?.cwd, ...projectRoots]
        .filter(Boolean)
        .map((projectRoot) => [path.win32.normalize(projectRoot).toLocaleLowerCase('en-US'), projectRoot]))
        .values()];
      const parentCounts = new Map();
      for (const projectRoot of distinctProjects) {
        const parent = path.win32.dirname(projectRoot);
        const key = parent.toLocaleLowerCase('en-US');
        parentCounts.set(key, { path: parent, count: (parentCounts.get(key)?.count ?? 0) + 1 });
      }
      for (const parent of parentCounts.values()) {
        const userHome = /^[a-z]:\\Users\\[^\\]+\\?$/i.test(parent.path);
        if (parent.count >= 2 && path.win32.dirname(parent.path) !== parent.path && !userHome) {
          roots.push(parent.path);
        }
      }
    }
    return roots;
  }

  async #inlineImageCardAttachments(binding, references, existingMessage, reservedNames = []) {
    if (this.config.fileShareEnabled === false) {
      return { attachments: [], files: [], names: [] };
    }
    const candidates = references.filter((reference) => isDiscordInlineImageTarget(reference.target));
    const availableSlots = Math.max(0, MAX_DISCORD_MESSAGE_ATTACHMENTS - reservedNames.length);
    if (candidates.length === 0 || availableSlots === 0) {
      return { attachments: [], files: [], names: [] };
    }

    const roots = await this.#allowedFileRoots(binding, { includeSiblingProjects: true });
    const maximumBytes = this.config.fileShareChunkBytes ?? 7_500_000;
    const existingAttachments = [...(existingMessage?.attachments.values() ?? [])];
    const usedNames = new Set(reservedNames.map((name) => name.toLocaleLowerCase('en-US')));
    const attachments = [];
    const files = [];
    const names = [];

    for (const reference of candidates) {
      if (names.length >= availableSlots) break;
      try {
        const file = await resolveShareFile(reference.target, roots);
        if (file.size > maximumBytes) {
          this.#log('inline-image-skipped', {
            threadId: binding.threadId,
            reason: `画像がDiscord添付上限を超えています (${file.size} > ${maximumBytes})`,
          });
          continue;
        }
        const transfer = await hashResolvedFile(file, maximumBytes);
        const attachmentName = uniqueDiscordAttachmentName(transfer.name, usedNames);
        usedNames.add(attachmentName.toLocaleLowerCase('en-US'));
        names.push(attachmentName);

        const existing = existingAttachments.find((attachment) => attachment.name === attachmentName
          && (attachment.size == null || attachment.size === transfer.size));
        if (existing) {
          attachments.push({ id: existing.id });
        } else {
          files.push(new AttachmentBuilder(
            await readHashedFile(transfer),
            { name: attachmentName },
          ));
        }
      } catch (error) {
        this.#log('inline-image-skipped', {
          threadId: binding.threadId,
          reason: error.message,
        });
      }
    }
    return { attachments, files, names };
  }

  async #codexImageCardAttachments(binding, item, existingMessage) {
    const maximumBytes = this.config.fileShareChunkBytes ?? 7_500_000;
    const extracted = codexImageFilesFromItem(item, {
      maximumBytes,
      maximumAttachments: MAX_DISCORD_MESSAGE_ATTACHMENTS,
    });
    for (const skipped of extracted.skipped) {
      this.#log('codex-image-skipped', {
        threadId: binding.threadId,
        itemId: item?.id ?? null,
        imageIndex: skipped.index,
        reason: skipped.reason,
      });
    }

    const existingAttachments = [...(existingMessage?.attachments.values() ?? [])];
    const attachments = [];
    const files = [];
    const names = [];
    const metadata = [];
    const usedNames = new Set();
    for (const file of extracted.files) {
      const name = uniqueDiscordAttachmentName(safeAttachmentName(file.name), usedNames);
      usedNames.add(name.toLocaleLowerCase('en-US'));
      names.push(name);
      metadata.push({
        name,
        mimeType: file.mimeType,
        size: file.size,
        sha256: file.sha256,
      });
      const existing = existingAttachments.find((attachment) => attachment.name === name
        && (attachment.size == null || attachment.size === file.size));
      if (existing) attachments.push({ id: existing.id });
      else files.push(new AttachmentBuilder(file.buffer, { name }));
    }

    if (this.config.fileShareEnabled !== false
      && item?.type === 'imageView'
      && typeof item.path === 'string'
      && names.length < MAX_DISCORD_MESSAGE_ATTACHMENTS) {
      try {
        if (!isDiscordInlineImageTarget(item.path)) throw new Error('Discordで表示できる画像形式ではありません。');
        const roots = await this.#allowedFileRoots(binding, { includeSiblingProjects: true });
        const resolved = await resolveShareFile(item.path, roots);
        if (resolved.size > maximumBytes) {
          throw new Error(`画像がDiscord添付上限を超えています (${resolved.size} > ${maximumBytes})`);
        }
        const transfer = await hashResolvedFile(resolved, maximumBytes);
        const name = uniqueDiscordAttachmentName(
          codexImagePathAttachmentName(item.id, transfer.name),
          usedNames,
        );
        names.push(name);
        metadata.push({
          name,
          mimeType: null,
          size: transfer.size,
          sha256: transfer.sha256,
        });
        const existing = existingAttachments.find((attachment) => attachment.name === name
          && (attachment.size == null || attachment.size === transfer.size));
        if (existing) attachments.push({ id: existing.id });
        else files.push(new AttachmentBuilder(await readHashedFile(transfer), { name }));
      } catch (error) {
        this.#log('codex-image-skipped', {
          threadId: binding.threadId,
          itemId: item?.id ?? null,
          imageIndex: 'path',
          reason: error.message,
        });
      }
    }
    return { attachments, files, names, metadata };
  }

  #fileSession(key, userId, type = null) {
    const session = this.pendingActions.get(key);
    if (!session || session.userId !== userId || (type && session.type !== type)) {
      throw new Error('ファイル画面は期限切れです。もう一度開いてください。');
    }
    if (Date.now() - session.createdAt > 30 * 60_000) {
      this.pendingActions.delete(key);
      throw new Error('ファイル画面は期限切れです。もう一度開いてください。');
    }
    return session;
  }

  #fileBrowserEntries(entries) {
    const maximum = this.config.fileShareMaxBytes ?? 512_000_000;
    return entries.map((entry) => entry.kind === 'file' && entry.size > maximum
      ? {
        ...entry,
        downloadable: false,
        lockedReason: `転送上限 ${formatFileSize(maximum)} を超えるファイル`,
      }
      : entry);
  }

  async #startFileBrowser(interaction, threadId) {
    this.#assertFileSharingEnabled();
    const binding = this.stateStore.binding(threadId);
    if (!binding) throw new Error('このタスクはまだDiscordに同期されていません。');
    if (!binding.cwd) throw new Error('このタスクには参照できる作業フォルダがありません。');
    const listing = await listProjectDirectory(binding.cwd);
    const key = randomKey();
    const session = {
      type: 'fileBrowser',
      key,
      userId: interaction.user.id,
      threadId,
      channelId: binding.channelId,
      root: listing.root,
      relativeDirectory: listing.relativeDirectory,
      entries: this.#fileBrowserEntries(listing.entries),
      page: 0,
      createdAt: Date.now(),
    };
    this.pendingActions.set(key, session);
    await interaction.editReply(fileBrowserPayload(session));
  }

  async #reloadFileBrowser(session, relativeDirectory = session.relativeDirectory) {
    const listing = await listProjectDirectory(session.root, relativeDirectory);
    session.relativeDirectory = listing.relativeDirectory;
    session.entries = this.#fileBrowserEntries(listing.entries);
    session.page = 0;
    session.createdAt = Date.now();
    return session;
  }

  #linkedReferences(binding, message) {
    const references = [];
    const records = binding?.turnMessages ?? {};
    for (const record of Object.values(records)) {
      for (const entry of Object.values(record.assistantEntries ?? {})) {
        if (!(entry.messageIds ?? []).includes(message.id)) continue;
        references.push(...(entry.localFiles ?? extractLocalFileReferences(entry.text)));
      }
      const finalIds = new Set([
        ...(record.finalMessageIds ?? []),
        record.cardMessageId,
        record.liveMessageId,
      ].filter(Boolean));
      if (finalIds.has(message.id)) references.push(...(record.finalLocalFiles ?? []));
    }
    if (references.length === 0) {
      for (const embed of message.embeds ?? []) {
        references.push(...extractLocalFileReferences(embed.description));
      }
    }
    const seen = new Set();
    return references.filter((reference) => {
      const key = String(reference.target).toLocaleLowerCase('en-US');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  async #showLinkedFilePicker(interaction) {
    const startedAt = Date.now();
    await interaction.deferReply({ ephemeral: true });
    this.#log('linked-file-picker-requested', {
      interactionId: interaction.id ?? null,
      channelId: interaction.channelId,
      messageId: interaction.message?.id ?? null,
      userId: interaction.user.id,
    });
    this.#assertFileSharingEnabled();
    const binding = this.stateStore.bindingByChannel(interaction.channelId);
    if (!binding) throw new Error('このメッセージはCodexタスクチャンネルにありません。');
    const references = this.#linkedReferences(binding, interaction.message);
    if (references.length === 0) throw new Error('このカードに取得可能なローカルファイルリンクはありません。');
    const roots = await this.#allowedFileRoots(binding, { includeSiblingProjects: true });
    const items = await Promise.all(references.map(async (reference) => {
      try {
        const file = await resolveShareFile(reference.target, roots);
        const maximum = this.config.fileShareMaxBytes ?? 512_000_000;
        if (file.size > maximum) {
          return {
            reference,
            file: null,
            error: `転送上限 ${formatFileSize(maximum)} を超えるファイル`,
          };
        }
        return { reference, file, error: null };
      } catch (error) {
        return { reference, file: null, error: error.message };
      }
    }));
    const key = randomKey();
    const session = {
      type: 'linkedFiles',
      key,
      userId: interaction.user.id,
      threadId: binding.threadId,
      channelId: binding.channelId,
      items,
      page: 0,
      createdAt: Date.now(),
    };
    this.pendingActions.set(key, session);
    await interaction.editReply(linkedFilePickerPayload(session));
    this.#log('linked-file-picker-opened', {
      interactionId: interaction.id ?? null,
      channelId: interaction.channelId,
      messageId: interaction.message?.id ?? null,
      threadId: binding.threadId,
      references: items.length,
      downloadable: items.filter((item) => item.file && !item.error).length,
      elapsedMs: Date.now() - startedAt,
    });
  }

  async #copyCardText(interaction) {
    const startedAt = Date.now();
    await interaction.deferReply({ ephemeral: true });
    const message = interaction.message;
    const binding = this.stateStore.bindingByChannel(interaction.channelId);
    if (!binding) throw new Error('このメッセージはCodexタスクチャンネルにありません。');
    if (!message) throw new Error('コピー元のカードを取得できません。');

    const embed = message.embeds?.[0] ?? null;
    const turnId = this.#embedTurnId(message);
    const record = turnId
      ? binding.turnMessages?.[turnId] ?? this.stateStore.turnRecord?.(binding.threadId, turnId) ?? {}
      : {};
    const userMessageId = this.#embedUserMessageId(message);
    const assistantMessageId = this.#embedAssistantMessageId(message);
    let value = userMessageId ? record.userEntries?.[userMessageId]?.text : null;
    if (!value && assistantMessageId) value = record.assistantEntries?.[assistantMessageId]?.text;
    if (!value && embed?.title === 'Codex running' && turnId) {
      value = this.turnViews.get(`${binding.threadId}:${turnId}`)?.text;
    }
    if (!value && /^Codex turn /.test(embed?.title ?? '')) value = record.finalText;

    if (!value) {
      const fullTextAttachment = [...(message.attachments?.values?.() ?? [])]
        .find((attachment) => /^codex-turn-.+-(?:user|assistant|final)\.txt$/i.test(attachment.name ?? ''));
      if (fullTextAttachment) {
        value = await this.#readInternalTextAttachment(fullTextAttachment).catch(() => null);
      }
    }
    value = String(value ?? embed?.description ?? message.content ?? '').trim();
    if (!value) throw new Error('このカードにはコピーできる本文がありません。');

    const escaped = value.replaceAll('```', '``\u200b`');
    const previewLimit = 1_700;
    const isLong = escaped.length > previewLimit;
    const preview = isLong ? `${escaped.slice(0, previewLimit)}\n…` : escaped;
    const options = messageOptions([
      '```text',
      preview,
      '```',
      ...(isLong ? ['全文は添付の `.txt` に入っています。'] : []),
    ].join('\n'));
    if (isLong) {
      options.files = [this.#textAttachment(value, `codex-card-${message.id}.txt`)];
    }
    await interaction.editReply(options);
    this.#log('card-text-copied', {
      interactionId: interaction.id ?? null,
      channelId: interaction.channelId,
      messageId: message.id,
      userId: interaction.user.id,
      title: embed?.title ?? null,
      textLength: value.length,
      attached: isLong,
      elapsedMs: Date.now() - startedAt,
    });
  }

  #discordMessageUrl(channelId, messageId) {
    return `https://discord.com/channels/${this.config.guildId}/${channelId}/${messageId}`;
  }

  async #sendLocalFile(channel, file, userId) {
    const volumeBytes = this.config.fileShareChunkBytes ?? 7_500_000;
    const maxBytes = this.config.fileShareMaxBytes ?? 512_000_000;
    if (file.size <= volumeBytes) {
      const transfer = await hashResolvedFile(file, maxBytes);
      const content = await readHashedFile(transfer);
      const message = await channel.send({
        content: [
          '**Codex local file**',
          `Path: \`${truncate(transfer.relativePath, 1200)}\``,
          `Size: ${formatFileSize(transfer.size)}`,
          `SHA-256: \`${transfer.sha256}\``,
        ].join('\n'),
        files: [new AttachmentBuilder(content, { name: safeAttachmentName(transfer.name) })],
        allowedMentions: { parse: [] },
      });
      this.#log('local-file-downloaded', {
        userId,
        channelId: channel.id,
        relativePath: transfer.relativePath,
        size: transfer.size,
        volumes: 1,
        format: 'direct-file-v1',
        sha256: transfer.sha256,
      });
      return message.url ?? this.#discordMessageUrl(channel.id, message.id);
    }

    const archive = await createSplit7zArchive(file, {
      volumeBytes,
      maxBytes,
      tempRoot: this.fileTransferTempRoot,
      archiverPath: this.config.fileShareArchiverPath,
    });
    try {
      const archiveSize = archive.volumes.reduce((total, volume) => total + volume.size, 0);
      const details = [
        '**Codex local file archive**',
        `Path: \`${truncate(archive.original.relativePath, 1200)}\``,
        `Original: ${formatFileSize(archive.original.size)}`,
        `Archive: ${formatFileSize(archiveSize)} / 7z / ${archive.volumes.length} volume(s)`,
        `Original SHA-256: \`${archive.original.sha256}\``,
        archive.volumes.length > 1
          ? `全volumeを同じフォルダへ保存し、\`${archive.volumes[0].name}\`を7z対応アプリで開いてください。`
          : `\`${archive.volumes[0].name}\`を7z対応アプリで開いてください。`,
      ];
      const firstMessage = await channel.send(messageOptions(details.join('\n')));
      const perMessage = this.config.fileShareAttachmentsPerMessage ?? 4;
      for (let index = 0; index < archive.volumes.length; index += perMessage) {
        const group = archive.volumes.slice(index, index + perMessage);
        const files = [];
        for (const volume of group) {
          files.push(new AttachmentBuilder(
            await readArchiveVolume(volume),
            { name: volume.name },
          ));
        }
        await channel.send({
          content: `**${archive.archiveName}** volumes ${group[0].index + 1}-${group.at(-1).index + 1}/${archive.volumes.length}`,
          files,
          allowedMentions: { parse: [] },
        });
      }
      const manifest = Buffer.from(`${JSON.stringify(splitArchiveManifest(archive), null, 2)}\n`, 'utf8');
      await channel.send({
        content: `**${archive.archiveName}** transfer manifest`,
        files: [new AttachmentBuilder(manifest, { name: safeAttachmentName(file.name, '.7z-manifest.json') })],
        allowedMentions: { parse: [] },
      });
      this.#log('local-file-downloaded', {
        userId,
        channelId: channel.id,
        relativePath: archive.original.relativePath,
        size: archive.original.size,
        archiveSize,
        volumes: archive.volumes.length,
        format: archive.format,
        sha256: archive.original.sha256,
      });
      return firstMessage.url ?? this.#discordMessageUrl(channel.id, firstMessage.id);
    } finally {
      await disposeSplitArchive(archive);
    }
  }

  async #sendLinkedFilesArchive(channel, files, skippedCount, userId, threadId) {
    const archive = await createSplitZipArchive(files, {
      volumeBytes: this.config.fileShareChunkBytes ?? 7_500_000,
      maxBytes: this.config.fileShareMaxBytes ?? 512_000_000,
      tempRoot: this.fileTransferTempRoot,
      archiverPath: this.config.fileShareArchiverPath,
    });
    try {
      const details = [
        '**Codex linked files ZIP**',
        `Files: ${archive.files.length}`,
        `Source: ${formatFileSize(archive.sourceBytes)}`,
        `ZIP: ${formatFileSize(archive.archiveBytes)} / ${archive.volumes.length} volume(s)`,
        ...(skippedCount > 0 ? [`Skipped unavailable links: ${skippedCount}`] : []),
        archive.volumes.length > 1
          ? `Place every volume in one folder and open \`${archive.volumes[0].name}\` with a ZIP/7z-compatible app.`
          : `Open \`${archive.volumes[0].name}\` with a ZIP-compatible app.`,
      ];
      const firstMessage = await channel.send(messageOptions(details.join('\n')));
      for (const volume of archive.volumes) {
        await channel.send({
          content: `**${archive.archiveName}** volume ${volume.index + 1}/${archive.volumes.length}`,
          files: [new AttachmentBuilder(
            await readArchiveVolume(volume),
            { name: volume.name },
          )],
          allowedMentions: { parse: [] },
        });
      }
      const manifest = Buffer.from(
        `${JSON.stringify(linkedFilesArchiveManifest(archive), null, 2)}\n`,
        'utf8',
      );
      await channel.send({
        content: `**${archive.archiveName}** transfer manifest`,
        files: [new AttachmentBuilder(
          manifest,
          { name: safeAttachmentName('linked-files', '.zip-manifest.json') },
        )],
        allowedMentions: { parse: [] },
      });
      this.#log('linked-files-archive-downloaded', {
        userId,
        channelId: channel.id,
        threadId,
        files: archive.files.length,
        skipped: skippedCount,
        sourceBytes: archive.sourceBytes,
        archiveBytes: archive.archiveBytes,
        volumes: archive.volumes.length,
        format: archive.format,
      });
      return firstMessage.url ?? this.#discordMessageUrl(channel.id, firstMessage.id);
    } finally {
      await disposeSplitArchive(archive);
    }
  }

  async #sendProjectArchive(channel, binding, userId) {
    this.#assertFileSharingEnabled();
    if (!binding.cwd) throw new Error('このタスクには取得できるプロジェクトフォルダがありません。');
    this.#log('project-archive-started', {
      userId,
      channelId: channel.id,
      threadId: binding.threadId,
      projectRoot: binding.cwd,
    });
    const archive = await createSplit7zProjectArchive(binding.cwd, {
      volumeBytes: this.config.fileShareChunkBytes ?? 7_500_000,
      tempRoot: this.fileTransferTempRoot,
      archiverPath: this.config.fileShareArchiverPath,
    });
    try {
      this.#log('project-archive-prepared', {
        userId,
        channelId: channel.id,
        threadId: binding.threadId,
        files: archive.project.files.length,
        sourceBytes: archive.project.sourceBytes,
        archiveBytes: archive.archiveBytes,
        volumes: archive.volumes.length,
      });
      const firstMessage = await channel.send(messageOptions([
        '**Codex project archive**',
        `Project: \`${truncate(archive.project.projectName, 500)}\``,
        `Files: ${archive.project.files.length} / Source: ${formatFileSize(archive.project.sourceBytes)}`,
        `Archive: ${formatFileSize(archive.archiveBytes)} / 7z / ${archive.volumes.length} volume(s)`,
        'Includes: `.git` and protected/secret-named regular files',
        `Skipped filesystem links/special entries: ${archive.project.skippedLinks.length + archive.project.skippedSpecial.length}`,
        archive.volumes.length > 1
          ? `全volumeを同じフォルダへ保存し、\`${archive.volumes[0].name}\`を7z対応アプリで開いてください。`
          : `\`${archive.volumes[0].name}\`を7z対応アプリで開いてください。`,
      ].join('\n')));
      for (const volume of archive.volumes) {
        await channel.send({
          content: `**${archive.archiveName}** volume ${volume.index + 1}/${archive.volumes.length}`,
          files: [new AttachmentBuilder(await readArchiveVolume(volume), { name: volume.name })],
          allowedMentions: { parse: [] },
        });
        this.#log('project-archive-volume-uploaded', {
          userId,
          channelId: channel.id,
          threadId: binding.threadId,
          volume: volume.index + 1,
          volumes: archive.volumes.length,
          bytes: volume.size,
        });
      }
      const manifest = Buffer.from(`${JSON.stringify(projectArchiveManifest(archive), null, 2)}\n`, 'utf8');
      await channel.send({
        content: `**${archive.archiveName}** project manifest`,
        files: [new AttachmentBuilder(manifest, {
          name: safeAttachmentName(archive.project.projectName, '.project.7z-manifest.json'),
        })],
        allowedMentions: { parse: [] },
      });
      this.#log('project-archive-downloaded', {
        userId,
        channelId: channel.id,
        threadId: binding.threadId,
        projectName: archive.project.projectName,
        files: archive.project.files.length,
        sourceBytes: archive.project.sourceBytes,
        archiveBytes: archive.archiveBytes,
        volumes: archive.volumes.length,
        skippedLinks: archive.project.skippedLinks.length,
        skippedSpecial: archive.project.skippedSpecial.length,
      });
      return firstMessage.url ?? this.#discordMessageUrl(channel.id, firstMessage.id);
    } finally {
      await disposeSplitArchive(archive);
    }
  }

  async #sendGitArchive(channel, binding, userId) {
    this.#assertFileSharingEnabled();
    if (!binding.cwd) throw new Error('このタスクには取得できるプロジェクトフォルダがありません。');
    this.#log('git-archive-started', {
      userId,
      channelId: channel.id,
      threadId: binding.threadId,
      projectRoot: binding.cwd,
    });
    const archive = await createSplit7zGitArchive(binding.cwd, {
      volumeBytes: this.config.fileShareChunkBytes ?? 7_500_000,
      tempRoot: this.fileTransferTempRoot,
      archiverPath: this.config.fileShareArchiverPath,
    });
    try {
      this.#log('git-archive-prepared', {
        userId,
        channelId: channel.id,
        threadId: binding.threadId,
        files: archive.project.files.length,
        sourceBytes: archive.project.sourceBytes,
        archiveBytes: archive.archiveBytes,
        volumes: archive.volumes.length,
        gitEntryType: archive.project.gitEntryType,
      });
      const firstMessage = await channel.send(messageOptions([
        '**Codex .git archive**',
        `Project: \`${truncate(archive.project.projectName, 500)}\``,
        `Files: ${archive.project.files.length} / Source: ${formatFileSize(archive.project.sourceBytes)}`,
        `Archive: ${formatFileSize(archive.archiveBytes)} / 7z / ${archive.volumes.length} volume(s)`,
        `Includes only: \`${archive.project.projectName}/.git\` (${archive.project.gitEntryType})`,
        `Skipped filesystem links/special entries: ${archive.project.skippedLinks.length + archive.project.skippedSpecial.length}`,
        archive.volumes.length > 1
          ? `全volumeを同じフォルダへ保存し、\`${archive.volumes[0].name}\`を7z対応アプリで開いてください。`
          : `\`${archive.volumes[0].name}\`を7z対応アプリで開いてください。`,
      ].join('\n')));
      for (const volume of archive.volumes) {
        await channel.send({
          content: `**${archive.archiveName}** volume ${volume.index + 1}/${archive.volumes.length}`,
          files: [new AttachmentBuilder(await readArchiveVolume(volume), { name: volume.name })],
          allowedMentions: { parse: [] },
        });
        this.#log('git-archive-volume-uploaded', {
          userId,
          channelId: channel.id,
          threadId: binding.threadId,
          volume: volume.index + 1,
          volumes: archive.volumes.length,
          bytes: volume.size,
        });
      }
      const manifest = Buffer.from(`${JSON.stringify(gitArchiveManifest(archive), null, 2)}\n`, 'utf8');
      await channel.send({
        content: `**${archive.archiveName}** .git manifest`,
        files: [new AttachmentBuilder(manifest, {
          name: safeAttachmentName(archive.project.projectName, '.git.7z-manifest.json'),
        })],
        allowedMentions: { parse: [] },
      });
      this.#log('git-archive-downloaded', {
        userId,
        channelId: channel.id,
        threadId: binding.threadId,
        projectName: archive.project.projectName,
        files: archive.project.files.length,
        sourceBytes: archive.project.sourceBytes,
        archiveBytes: archive.archiveBytes,
        volumes: archive.volumes.length,
        skippedLinks: archive.project.skippedLinks.length,
        skippedSpecial: archive.project.skippedSpecial.length,
        gitEntryType: archive.project.gitEntryType,
      });
      return firstMessage.url ?? this.#discordMessageUrl(channel.id, firstMessage.id);
    } finally {
      await disposeSplitArchive(archive);
    }
  }

  async #downloadFile(interaction, file, threadId) {
    const binding = this.stateStore.binding(threadId);
    if (!binding) throw new Error('ファイルの投稿先タスクが見つかりません。');
    const channel = binding.channelId === interaction.channelId && interaction.channel
      ? interaction.channel
      : await this.client.channels.fetch(binding.channelId);
    if (!channel?.isTextBased?.() && typeof channel?.send !== 'function') {
      throw new Error('ファイルの投稿先タスクチャンネルが利用できません。');
    }
    const url = await this.#sendLocalFile(channel, file, interaction.user.id);
    await interaction.followUp(messageOptions(`タスクチャンネルへ投稿しました。\n${url}`, { ephemeral: true }));
  }

  async #downloadLinkedFiles(interaction, session) {
    const binding = this.stateStore.binding(session.threadId);
    if (!binding) throw new Error('The linked-file task is no longer available.');
    const channel = binding.channelId === interaction.channelId && interaction.channel
      ? interaction.channel
      : await this.client.channels.fetch(binding.channelId);
    if (!channel?.isTextBased?.() && typeof channel?.send !== 'function') {
      throw new Error('The linked-file task channel is unavailable.');
    }
    const eligible = session.items.filter((item) => item.file && !item.error);
    if (eligible.length === 0) throw new Error('There are no downloadable linked files.');
    const roots = await this.#allowedFileRoots(binding, { includeSiblingProjects: true });
    const files = [];
    for (const item of eligible) {
      files.push(await resolveShareFile(item.reference.target, roots));
    }
    const url = await this.#sendLinkedFilesArchive(
      channel,
      files,
      session.items.length - eligible.length,
      interaction.user.id,
      session.threadId,
    );
    await interaction.followUp(messageOptions(`Linked files were posted as a ZIP.\n${url}`, { ephemeral: true }));
  }

  async #handleCommand(interaction) {
    await this.infrastructureReady;
    const subcommand = interaction.options.getSubcommand();
    const subcommandGroup = interaction.options.getSubcommandGroup(false);
    this.#log('command', {
      subcommandGroup, subcommand, userId: interaction.user.id, channelId: interaction.channelId,
    });
    if (['tasks', 'open', 'pending', 'sync', 'usage'].includes(subcommand)) {
      this.#assertControlOperator(interaction);
    }

    if (subcommand === 'status') {
      await interaction.deferReply({ ephemeral: true });
      const explicit = interaction.options.getString('task');
      const channelBinding = this.stateStore.bindingByChannel(interaction.channelId);
      const threadId = explicit ?? channelBinding?.threadId ?? null;
      if (threadId) {
        this.#assertThreadAccess(interaction, threadId);
        await this.#showTaskStatus(interaction, threadId);
      } else {
        this.#assertControlOperator(interaction);
        await interaction.editReply({ embeds: [await this.#statusEmbed()] });
      }
      return;
    }

    if (subcommand === 'tasks') {
      await interaction.deferReply({ ephemeral: true });
      const search = interaction.options.getString('search');
      const result = await this.codex.listThreads({ limit: 25, search });
      const desktopProjects = readDesktopProjectSnapshot(this.config.desktopGlobalStatePath);
      const threads = result.data.filter((thread) => {
        const descriptor = projectDescriptorForThread(
          thread,
          desktopProjects,
          this.config.projectCategoryPrefix,
        );
        return !this.#hiddenProjectDescriptorForThread(thread, descriptor);
      });
      if (!threads.length) {
        await interaction.editReply('タスクが見つかりませんでした。');
        return;
      }
      const menu = new StringSelectMenuBuilder()
        .setCustomId('cx:open')
        .setPlaceholder('Discordで開くCodexタスクを選択')
        .addOptions(threads.slice(0, 25).map((thread) => new StringSelectMenuOptionBuilder()
          .setLabel(truncate(`${threadStatusEmoji(thread.status)} ${thread.name ?? thread.preview ?? thread.id}`, 100, ''))
          .setDescription(truncate(`${threadStatusLabel(thread.status)} | ${thread.cwd ?? '(no cwd)'}`, 100, ''))
          .setValue(thread.id)));
      const rows = new ActionRowBuilder().addComponents(menu);
      const list = threads.slice(0, 10)
        .map((thread) => `- ${threadStatusEmoji(thread.status)} **${truncate(thread.name ?? thread.preview ?? '(untitled)', 80)}** - ${threadStatusLabel(thread.status)}`)
        .join('\n');
      await interaction.editReply({ content: list, components: [rows] });
      return;
    }

    if (subcommand === 'open') {
      await interaction.deferReply({ ephemeral: true });
      const threadId = interaction.options.getString('task', true);
      const result = await this.codex.threadMetadata(threadId);
      this.#assertThreadVisible(result.thread);
      const channel = await this.#openTaskChannel(result.thread);
      await interaction.editReply(`開きました: ${channelMention(channel.id)}`);
      return;
    }

    if (['deliver', 'send', 'steer'].includes(subcommand)) {
      await interaction.deferReply({ ephemeral: true });
      const threadId = this.#resolveThreadId(interaction);
      const prompt = interaction.options.getString('prompt', true);
      const discordAttachment = interaction.options.getAttachment('attachment');
      const attachments = discordAttachment
        ? await this.#prepareAttachments([discordAttachment], threadId, interaction.id)
        : [];
      const mirror = this.#reserveUserInput(
        threadId,
        prompt,
        `Discord: ${interaction.user.tag}`,
        { executorUserId: interaction.user.id },
      );
      let result;
      try {
        result = await this.codex[subcommand](
          threadId,
          prompt,
          attachments,
          mirror.clientUserMessageId,
        );
      } catch (error) {
        this.#removeUserInputReservation(mirror);
        throw error;
      }
      mirror.turnId ??= result.turnId;
      await this.#ensureReservedUserInputPosted(mirror).catch((error) => {
        this.#log('user-input-mirror-error', { threadId, source: mirror.source, error: error.message });
      });
      await this.#moveLiveCardAfterReservedInput(mirror);
      await interaction.editReply(`受理されました: **${result.mode}** / turn \`${result.turnId ?? 'pending'}\``);
      return;
    }

    if (subcommand === 'compose') {
      const threadId = this.#resolveThreadId(interaction);
      const mode = interaction.options.getString('mode', true);
      await this.#showComposeModal(interaction, threadId, mode);
      return;
    }

    if (subcommand === 'interrupt') {
      const threadId = this.#resolveThreadId(interaction);
      await this.#showInterruptConfirmation(interaction, threadId);
      return;
    }

    if (subcommand === 'watch') {
      const threadId = this.#resolveThreadId(interaction);
      const level = interaction.options.getString('level', true);
      const binding = this.stateStore.binding(threadId);
      if (!binding) throw new Error('このタスクはまだ自動同期されていません。/codex sync を実行してください。');
      this.stateStore.setBinding(threadId, { watchLevel: level });
      await interaction.reply(messageOptions(`通知レベルを **${level}** に設定しました。`, { ephemeral: true }));
      return;
    }

    if (subcommand === 'pending') {
      await interaction.reply(messageOptions(this.#pendingContent(), { ephemeral: true }));
      return;
    }

    if (subcommand === 'sync') {
      await interaction.deferReply({ ephemeral: true });
      const result = await this.#syncAllTasks();
      await interaction.editReply(this.#syncResultText(result));
      return;
    }

    if (subcommand === 'refresh') {
      await interaction.deferReply({ ephemeral: true });
      const threadId = this.#resolveThreadId(interaction);
      const result = await this.codex.readThread(threadId);
      const latest = [...(result.thread.turns ?? [])].reverse()[0];
      const embed = this.#threadEmbed(result.thread, latest);
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    if (['model', 'reasoning', 'permissions', 'mode'].includes(subcommand)) {
      const threadId = this.#resolveThreadId(interaction);
      const optionNames = { model: 'model', reasoning: 'effort', permissions: 'profile', mode: 'mode' };
      const value = interaction.options.getString(optionNames[subcommand]);
      if (!value) {
        await interaction.deferReply({ ephemeral: true });
        await this.#showTaskControls(interaction, threadId);
        return;
      }
      if (subcommand === 'permissions') {
        await this.#showConfirmation(
          interaction,
          { type: 'permission', threadId, profile: value },
          `権限プロファイルを **${value}** に変更しますか？以降のターンのfilesystem、network、approval境界が変わる可能性があります。`,
          '権限を変更',
        );
        return;
      }
      await interaction.deferReply({ ephemeral: true });
      if (subcommand === 'model') await this.#applyThreadSettings(threadId, { model: value });
      else if (subcommand === 'reasoning') await this.#applyThreadSettings(threadId, { effort: value === '__default__' ? null : value });
      else await this.#applyCollaborationMode(threadId, value);
      await this.#showTaskControls(interaction, threadId);
      return;
    }

    if (subcommand === 'memory') {
      const threadId = this.#resolveThreadId(interaction);
      const mode = interaction.options.getString('mode');
      if (!mode) {
        await interaction.deferReply({ ephemeral: true });
        await this.#showTaskControls(interaction, threadId);
        return;
      }
      await interaction.deferReply({ ephemeral: true });
      await this.codex.setMemoryMode(threadId, mode);
      this.stateStore.setBinding(threadId, { memoryMode: mode });
      await this.#showTaskControls(interaction, threadId);
      return;
    }

    if (subcommand === 'usage') {
      await interaction.deferReply({ ephemeral: true });
      await interaction.editReply({ embeds: [await this.#accountUsageResponse()] });
      return;
    }

    if (subcommand === 'resources') {
      await interaction.deferReply({ ephemeral: true });
      const kind = interaction.options.getString('kind', true);
      const explicit = interaction.options.getString('task');
      const threadId = explicit ?? this.stateStore.bindingByChannel(interaction.channelId)?.threadId ?? null;
      if (threadId) this.#assertThreadAccess(interaction, threadId);
      else this.#assertControlOperator(interaction);
      await interaction.editReply({ embeds: [await this.#resourceResponse(kind, threadId)] });
      return;
    }

    if (subcommand === 'goal') {
      const threadId = this.#resolveThreadId(interaction);
      const action = interaction.options.getString('action', true);
      if (action === 'view') {
        await interaction.deferReply({ ephemeral: true });
        const result = await this.codex.getGoal(threadId);
        await interaction.editReply(goalPayload(threadId, result.goal ?? null));
        return;
      }
      if (action === 'clear') {
        await this.#showConfirmation(
          interaction,
          { type: 'goalclear', threadId },
          'このタスクのgoalを解除しますか？',
          'Goalを解除',
        );
        return;
      }
      const objective = interaction.options.getString('objective');
      if (!objective) {
        await this.#showGoalModal(interaction, threadId);
        return;
      }
      await interaction.deferReply({ ephemeral: true });
      const budget = interaction.options.getInteger('token-budget');
      const result = await this.codex.setGoal(threadId, objective, budget);
      await interaction.editReply(goalPayload(threadId, result.goal));
      return;
    }

    if (subcommand === 'compact') {
      const threadId = this.#resolveThreadId(interaction);
      await this.#showConfirmation(
        interaction,
        { type: 'compact', threadId },
        'このタスクのcontextをcompactしますか？処理はapp-serverの `thread/compact/start` で行います。',
        'Compact',
      );
      return;
    }

    if (subcommand === 'fork') {
      const threadId = this.#resolveThreadId(interaction);
      const lastTurnId = interaction.options.getString('last-turn');
      await this.#showConfirmation(
        interaction,
        { type: 'fork', threadId, lastTurnId },
        `このタスクをforkしますか？${lastTurnId ? ` turn \`${lastTurnId}\` までを含めます。` : ''}`,
        'Fork',
      );
      return;
    }

    if (subcommand === 'review') {
      const threadId = this.#resolveThreadId(interaction);
      const kind = interaction.options.getString('target', true);
      const value = interaction.options.getString('value');
      const delivery = interaction.options.getString('delivery') ?? 'inline';
      if (kind !== 'uncommitted' && !value) {
        await this.#showReviewModal(interaction, threadId, kind, delivery);
        return;
      }
      await interaction.deferReply({ ephemeral: true });
      const result = await this.#startReview(threadId, kind, value, delivery);
      await interaction.editReply(result.text);
      return;
    }

    if (subcommand === 'terminals') {
      const threadId = this.#resolveThreadId(interaction);
      const action = interaction.options.getString('action', true);
      await interaction.deferReply({ ephemeral: true });
      const terminals = await this.codex.listBackgroundTerminals(threadId);
      if (action === 'list') {
        await interaction.editReply(terminalPayload(threadId, terminals));
        return;
      }
      const processId = interaction.options.getString('process');
      if (!processId) throw new Error('terminateにはprocessを指定してください。listまたはControlsからprocess IDを確認できます。');
      const terminal = terminals.find((candidate) => candidate.processId === processId);
      if (!terminal) throw new Error(`背景ターミナル ${processId} が見つかりません。`);
      await this.#showConfirmation(
        interaction,
        { type: 'terminal', threadId, processId },
        `app-server管理の背景ターミナル \`${processId}\` (PID ${terminal.osPid ?? 'unknown'}) を終了しますか？\n${truncate(terminal.command, 1200)}`,
        'Terminalを終了',
      );
      return;
    }

    if (subcommand === 'help') {
      const content = [
        '**基本操作**',
        '全タスクはプロジェクト別カテゴリへ常時自動同期されます。',
        'アーカイブ済みタスクは Codex Archived へ移動します。',
        '`/codex tasks` タスクチャンネルを選択して開く',
        '`/codex compose` モバイル向け複数行入力',
        '`/codex deliver` 稼働中ならsteer、待機中なら新しいターン',
        '`/codex sync` 全タスクとカテゴリを今すぐ再同期',
        'Codex Remoteの「プロジェクト表示」から、指定プロジェクトのDiscordミラーを非表示・再表示',
        '`/codex watch` 通知量を変更',
        '`/codex interrupt` 確認後にapp-server経由で中断',
        '`/codex status` タスクチャンネルではモデル・権限・goal等も表示',
        '`/codex model|reasoning|permissions|mode|memory` タスク設定',
        '`/codex compact|fork|review|terminals` app-serverのタスク操作',
        '`/codex usage|resources` 使用量とCodexリソースの参照',
        '',
        'app-serverはPCのloopbackから外へ公開しません。Discord Botだけが外向き接続します。',
      ].join('\n');
      await interaction.reply(messageOptions(content, { ephemeral: true }));
    }
  }

  async #handleFilesCommand(interaction) {
    await this.infrastructureReady;
    await interaction.deferReply({ ephemeral: true });
    const threadId = this.#resolveThreadId(interaction);
    await this.#startFileBrowser(interaction, threadId);
  }

  async #handleSelect(interaction) {
    const uiParts = interaction.customId.split(':');
    if (uiParts[0] === 'cx' && uiParts[1] === 'projects' && uiParts[3] === 'select') {
      this.#assertControlPanelInteraction(interaction);
      const session = this.#projectVisibilitySession(uiParts[2], interaction.user.id);
      const selected = Number.parseInt(interaction.values[0], 10);
      if (!Number.isInteger(selected)) throw new Error('選択されたプロジェクトが不正です。');
      const selectedProject = session.projects[selected];
      if (!selectedProject) throw new Error('選択されたプロジェクトは期限切れです。Refreshしてください。');
      this.#refreshProjectVisibilitySession(session);
      const project = session.projects.find(
        (candidate) => candidate.projectKey === selectedProject.projectKey,
      );
      if (!project) throw new Error('選択されたプロジェクトは期限切れです。Refreshしてください。');
      const hide = !project.hidden;
      await interaction.deferUpdate();
      await this.#showConfirmation(
        interaction,
        {
          type: 'projectVisibility',
          project: {
            projectKey: project.projectKey,
            projectId: project.projectId,
            path: project.path,
            name: project.name,
          },
          hidden: hide,
        },
        hide
          ? [
            `**${project.name}**（\`${truncate(project.path, 1200)}\`）をDiscordから非表示にしますか？`,
            `このプロジェクトのDiscordカテゴリと配下チャンネル（現在の紐付けタスク ${project.taskCount}件、サブエージェントスレッドを含む）、関連する完了通知を削除します。`,
            'Codexのtask/threadとローカルファイルは削除しません。再表示時に履歴からDiscordミラーを作り直せます。',
            'Discordだけに存在する途中カードや添付は復元できません。',
          ].join('\n')
          : [
            `**${project.name}**（\`${truncate(project.path, 1200)}\`）をDiscordへ再表示しますか？`,
            'Codexに残るtask/threadから、カテゴリ、タスクチャンネル、取得可能な履歴を再作成します。',
          ].join('\n'),
        hide ? 'Discordから削除' : '再表示',
        hide ? ButtonStyle.Danger : ButtonStyle.Success,
      );
      return;
    }
    if (uiParts[0] === 'cx' && uiParts[1] === 'files') {
      const action = uiParts[2];
      const session = this.#fileSession(
        uiParts[3],
        interaction.user.id,
        action === 'browse' ? 'fileBrowser' : 'linkedFiles',
      );
      const selected = Number.parseInt(interaction.values[0], 10);
      if (!Number.isInteger(selected)) throw new Error('選択されたファイル項目が不正です。');
      if (action === 'browse') {
        const entry = session.entries[selected];
        if (!entry) throw new Error('選択されたファイル項目は期限切れです。Refreshしてください。');
        if (entry.lockedReason) {
          await interaction.reply(messageOptions(`ダウンロードできません: ${entry.lockedReason}`, { ephemeral: true }));
          return;
        }
        await interaction.deferUpdate();
        if (entry.navigable) {
          await this.#reloadFileBrowser(session, entry.relativePath);
          await interaction.editReply(fileBrowserPayload(session));
          return;
        }
        try {
          const target = path.win32.join(session.root, entry.relativePath);
          const file = await resolveShareFile(target, [session.root]);
          await this.#downloadFile(interaction, file, session.threadId);
        } catch (error) {
          await interaction.followUp(messageOptions(`ダウンロードできません: ${error.message}`, { ephemeral: true }));
        }
        return;
      }
      if (action === 'linkedpick') {
        const item = session.items[selected];
        if (!item) throw new Error('選択されたリンクは期限切れです。カードから開き直してください。');
        if (item.error) {
          await interaction.reply(messageOptions(`ダウンロードできません: ${item.error}`, { ephemeral: true }));
          return;
        }
        await interaction.deferUpdate();
        try {
          const binding = this.stateStore.binding(session.threadId);
          const roots = await this.#allowedFileRoots(binding, { includeSiblingProjects: true });
          const file = await resolveShareFile(item.reference.target, roots);
          await this.#downloadFile(interaction, file, session.threadId);
        } catch (error) {
          await interaction.followUp(messageOptions(`ダウンロードできません: ${error.message}`, { ephemeral: true }));
        }
        return;
      }
      return;
    }
    if (uiParts[0] === 'cx' && uiParts[1] === 'ctl') {
      const action = uiParts[2];
      const threadId = uiParts[3];
      this.#assertTaskPanelInteraction(interaction, threadId);
      const selected = interaction.values[0];
      if (selected === '__unavailable__') return;
      if (action === 'model' || action === 'effort' || action === 'tier' || action === 'personality') {
        await interaction.deferUpdate();
        const patch = action === 'model' ? { model: selected }
          : action === 'effort' ? { effort: selected === '__default__' ? null : selected }
            : action === 'tier' ? { serviceTier: selected === '__default__' ? null : selected }
              : { personality: selected };
        await this.#applyThreadSettings(threadId, patch);
        await this.#showTaskControls(interaction, threadId);
        return;
      }
      if (action === 'mode') {
        await interaction.deferUpdate();
        await this.#applyCollaborationMode(threadId, selected);
        await this.#showTaskControls(interaction, threadId);
        return;
      }
      if (action === 'memory') {
        await interaction.deferUpdate();
        await this.codex.setMemoryMode(threadId, selected);
        this.stateStore.setBinding(threadId, { memoryMode: selected });
        await this.#showTaskControls(interaction, threadId);
        return;
      }
      if (action === 'permission') {
        await interaction.deferUpdate();
        await this.#showConfirmation(
          interaction,
          { type: 'permission', threadId, profile: selected },
          `権限プロファイルを **${selected}** に変更しますか？以降のターンのfilesystem、network、approval境界が変わる可能性があります。`,
          '権限を変更',
        );
        return;
      }
      if (action === 'more') {
        await interaction.deferUpdate();
        if (selected === 'status') {
          await this.#showTaskStatus(interaction, threadId);
          return;
        }
        if (['tier', 'personality', 'memory'].includes(selected)) {
          const context = await this.#controlContext(threadId);
          await interaction.editReply(secondarySettingsPayload({ ...context, kind: selected }));
          return;
        }
        if (selected === 'goal') {
          const result = await this.codex.getGoal(threadId);
          await interaction.editReply(goalPayload(threadId, result.goal ?? null));
          return;
        }
        if (selected === 'compact') {
          await this.#showConfirmation(
            interaction,
            { type: 'compact', threadId },
            'このタスクのcontextをcompactしますか？処理はapp-serverの `thread/compact/start` で行います。',
            'Compact',
          );
          return;
        }
        if (selected === 'fork') {
          await this.#showConfirmation(
            interaction,
            { type: 'fork', threadId, lastTurnId: null },
            'このタスクの全履歴から新しいタスクをforkしますか？',
            'Fork',
          );
          return;
        }
        if (selected === 'review') {
          await interaction.editReply(reviewPayload(threadId));
          return;
        }
        if (selected === 'terminals') {
          const terminals = await this.codex.listBackgroundTerminals(threadId);
          await interaction.editReply(terminalPayload(threadId, terminals));
          return;
        }
        return;
      }
      if (action === 'review') {
        const [kind, delivery] = selected.split(':');
        if (kind === 'uncommitted') {
          await interaction.deferUpdate();
          const result = await this.#startReview(threadId, kind, null, delivery);
          await interaction.editReply({ content: result.text, embeds: [], components: [] });
        } else {
          await this.#showReviewModal(interaction, threadId, kind, delivery);
        }
        return;
      }
      if (action === 'terminal') {
        await interaction.deferUpdate();
        const terminals = await this.codex.listBackgroundTerminals(threadId);
        const terminal = terminals.find((candidate) => candidate.processId === selected);
        if (!terminal) throw new Error(`背景ターミナル ${selected} が見つかりません。`);
        await this.#showConfirmation(
          interaction,
          { type: 'terminal', threadId, processId: selected },
          `app-server管理の背景ターミナル \`${selected}\` (PID ${terminal.osPid ?? 'unknown'}) を終了しますか？\n${truncate(terminal.command, 1200)}`,
          'Terminalを終了',
        );
        return;
      }
      return;
    }
    if (uiParts[0] === 'cx' && uiParts[1] === 'ui') {
      if (uiParts[2] === 'control' && uiParts[3] === 'open') {
        this.#assertControlPanelInteraction(interaction);
        await interaction.deferUpdate();
        const threadId = interaction.values[0];
        const result = await this.codex.threadMetadata(threadId);
        const channel = await this.#openTaskChannel(result.thread);
        await interaction.followUp(messageOptions(`開きました: ${channelMention(channel.id)}`, { ephemeral: true }));
        return;
      }
      if (uiParts[2] === 'control' && uiParts[3] === 'resources') {
        this.#assertControlPanelInteraction(interaction);
        await interaction.deferReply({ ephemeral: true });
        await interaction.editReply({ embeds: [await this.#resourceResponse(interaction.values[0])] });
        return;
      }
      if (uiParts[2] === 'control' && uiParts[3] === 'recent-history-days') {
        this.#assertControlPanelInteraction(interaction);
        const days = Number.parseInt(interaction.values[0], 10);
        if (!RECENT_HISTORY_DAY_OPTIONS.includes(days)) {
          throw new Error('履歴復元の日数が不正です。1日、3日、7日から選択してください。');
        }
        await interaction.deferUpdate();
        const cutoff = new Date(recentHistoryCutoffMs(days)).toLocaleString('ja-JP', {
          timeZone: 'Asia/Tokyo',
        });
        await this.#showConfirmation(
          interaction,
          { type: 'recentHistoryRestore', days },
          [
            `Discord管理対象の全ての非アーカイブタスクについて、過去 **${days}日** の履歴を復元しますか？`,
            `対象期間: ${cutoff}（日本時間）以降`,
            'ユーザー発言、commentary、最終回答、取得可能な推論要約をカードとして復元します。',
            '処理はバックグラウンドで進み、完了結果をCodex Remoteへ投稿します。',
          ].join('\n'),
          '履歴を復元',
        );
        return;
      }
      if (uiParts[2] === 'task') {
        const action = uiParts[3];
        const threadId = uiParts[4];
        const binding = this.#assertTaskPanelInteraction(interaction, threadId);
        if (action === 'compose') {
          await this.#showComposeModal(interaction, threadId, interaction.values[0]);
          return;
        }
        if (action === 'watch') {
          const level = interaction.values[0];
          if (!['quiet', 'normal', 'verbose'].includes(level)) throw new Error(`Unknown watch level: ${level}`);
          await interaction.deferUpdate();
          this.stateStore.setBinding(threadId, { watchLevel: level });
          const result = await this.codex.threadMetadata(threadId).catch(() => null);
          const channel = interaction.channel ?? await this.client.channels.fetch(binding.channelId);
          await this.#ensureTaskPanel(result?.thread ?? this.#threadFromBinding({ ...binding, watchLevel: level }), channel, binding.archived);
          await interaction.followUp(messageOptions(`通知レベルを **${level}** に設定しました。`, { ephemeral: true }));
          return;
        }
        if (action === 'completion') {
          const selection = interaction.values[0];
          if (!['enabled', 'disabled'].includes(selection)) {
            throw new Error(`Unknown completion-report setting: ${selection}`);
          }
          const enabled = selection === 'enabled';
          await interaction.deferUpdate();
          this.stateStore.setBinding(threadId, { completionReportsEnabled: enabled });
          const result = await this.codex.threadMetadata(threadId).catch(() => null);
          const channel = interaction.channel ?? await this.client.channels.fetch(binding.channelId);
          await this.#ensureTaskPanel(
            result?.thread ?? this.#threadFromBinding({ ...binding, completionReportsEnabled: enabled }),
            channel,
            binding.archived,
          );
          await interaction.followUp(messageOptions(
            `完了報告への投稿を **${enabled ? 'ON' : 'OFF'}** に設定しました。`,
            { ephemeral: true },
          ));
          return;
        }
      }
      return;
    }

    if (interaction.customId === 'cx:open') {
      await interaction.deferUpdate();
      const threadId = interaction.values[0];
      const result = await this.codex.threadMetadata(threadId);
      const channel = await this.#openTaskChannel(result.thread);
      await interaction.followUp(messageOptions(`開きました: ${channelMention(channel.id)}`, { ephemeral: true }));
      return;
    }

    const [prefix, kind, key, indexText] = interaction.customId.split(':');
    if (prefix !== 'cx' || kind !== 'q') return;
    const record = this.pendingRequests.get(key);
    this.#assertPendingRequest(record);
    const index = Number.parseInt(indexText, 10);
    const question = record.request.params.questions[index];
    const selected = interaction.values[0];
    if (selected === '__other__') {
      const modal = new ModalBuilder().setCustomId(`cx:input:${key}:toolq:${index}`).setTitle(truncate(question.header, 45, ''))
        .addComponents(userInputField('answer', question.question, { secret: question.isSecret }));
      await interaction.showModal(modal);
      return;
    }
    const optionIndex = Number.parseInt(selected, 10);
    record.answers[question.id] = { answers: [question.options[optionIndex].label] };
    await interaction.deferUpdate();
    await this.#completeToolInputIfReady(record, interaction);
  }

  async #handleButton(interaction) {
    const parts = interaction.customId.split(':');
    if (parts[0] !== 'cx') return;
    if (parts[1] === 'projects') {
      this.#assertControlPanelInteraction(interaction);
      const session = this.#projectVisibilitySession(parts[2], interaction.user.id);
      const action = parts[3];
      await interaction.deferUpdate();
      if (action === 'close') {
        this.pendingActions.delete(parts[2]);
        await interaction.editReply({ content: 'プロジェクト表示画面を閉じました。', embeds: [], components: [] });
        return;
      }
      if (action === 'prev') session.page = Math.max(0, session.page - 1);
      if (action === 'next') session.page += 1;
      this.#refreshProjectVisibilitySession(session);
      await interaction.editReply(projectVisibilityPayload(session));
      return;
    }
    if (parts[1] === 'copy' && parts[2] === 'card') {
      await this.#copyCardText(interaction);
      return;
    }
    if (parts[1] === 'files') {
      if (parts[2] === 'linked') {
        await this.#showLinkedFilePicker(interaction);
        return;
      }
      if (parts[2] === 'nav') {
        const session = this.#fileSession(parts[3], interaction.user.id, 'fileBrowser');
        const action = parts[4];
        await interaction.deferUpdate();
        if (action === 'close') {
          this.pendingActions.delete(parts[3]);
          await interaction.editReply({ content: 'ファイルブラウザを閉じました。', embeds: [], components: [] });
          return;
        }
        if (action === 'up') {
          const parent = session.relativeDirectory ? path.win32.dirname(session.relativeDirectory) : '';
          await this.#reloadFileBrowser(session, parent === '.' ? '' : parent);
        } else if (action === 'refresh') {
          await this.#reloadFileBrowser(session);
        } else if (action === 'prev') {
          session.page = Math.max(0, session.page - 1);
        } else if (action === 'next') {
          session.page += 1;
        }
        session.createdAt = Date.now();
        await interaction.editReply(fileBrowserPayload(session));
        return;
      }
      if (parts[2] === 'linkednav') {
        const session = this.#fileSession(parts[3], interaction.user.id, 'linkedFiles');
        const action = parts[4];
        await interaction.deferUpdate();
        if (action === 'download') {
          try {
            await this.#downloadLinkedFiles(interaction, session);
          } catch (error) {
            await interaction.followUp(messageOptions(`ZIP download failed: ${error.message}`, { ephemeral: true }));
          }
          return;
        }
        if (action === 'close') {
          this.pendingActions.delete(parts[3]);
          await interaction.editReply({ content: 'リンク一覧を閉じました。', embeds: [], components: [] });
          return;
        }
        if (action === 'prev') session.page = Math.max(0, session.page - 1);
        if (action === 'next') session.page += 1;
        session.createdAt = Date.now();
        await interaction.editReply(linkedFilePickerPayload(session));
        return;
      }
      return;
    }
    if (parts[1] === 'ui') {
      const surface = parts[2];
      const action = parts[3];
      if (surface === 'control') {
        this.#assertControlPanelInteraction(interaction);
        if (action === 'status') {
          await interaction.deferReply({ ephemeral: true });
          await interaction.editReply({ embeds: [await this.#statusEmbed()] });
          return;
        }
        if (action === 'sync') {
          await interaction.deferReply({ ephemeral: true });
          await interaction.editReply(this.#syncResultText(await this.#syncAllTasks()));
          return;
        }
        if (action === 'usage') {
          await interaction.deferReply({ ephemeral: true });
          await interaction.editReply({ embeds: [await this.#accountUsageResponse()] });
          return;
        }
        if (action === 'pending') {
          await interaction.reply(messageOptions(this.#pendingContent(), { ephemeral: true }));
          return;
        }
        if (action === 'recent-history') {
          await interaction.reply({ ...recentHistoryPayload(), ephemeral: true });
          return;
        }
        if (action === 'projects') {
          await this.#showProjectVisibility(interaction);
          return;
        }
        return;
      }
      if (surface === 'task') {
        const threadId = parts[4];
        const binding = this.#assertTaskPanelInteraction(interaction, threadId);
        if (action === 'refresh') {
          await interaction.deferReply({ ephemeral: true });
          const result = await this.codex.readThread(threadId);
          const channel = interaction.channel ?? await this.client.channels.fetch(binding.channelId);
          await this.#ensureTaskPanel(result.thread, channel, binding.archived);
          await this.#showTaskStatus(interaction, threadId);
          return;
        }
        if (action === 'pending') {
          await interaction.reply(messageOptions(this.#pendingContent(threadId), { ephemeral: true }));
          return;
        }
        if (action === 'interrupt') {
          await this.#showInterruptConfirmation(interaction, threadId);
          return;
        }
        if (action === 'controls') {
          await interaction.deferReply({ ephemeral: true });
          await this.#showTaskControls(interaction, threadId);
          return;
        }
        if (action === 'files') {
          await interaction.deferReply({ ephemeral: true });
          await this.#startFileBrowser(interaction, threadId);
          return;
        }
        if (action === 'project') {
          this.#assertFileSharingEnabled();
          await this.#showConfirmation(
            interaction,
            { type: 'projectArchive', threadId },
            [
              `プロジェクト全体 \`${truncate(binding.cwd, 1200)}\` をタスクチャンネルへ投稿しますか？`,
              '`.git`、`.env`、鍵・資格情報など、通常のファイルブラウザでは保護される通常ファイルも含まれます。',
              projectArchiveVolumeText(this.config),
              'symlink・junction・特殊ファイルはプロジェクト外参照を防ぐため含めません。',
            ].join('\n'),
            'Archiveを作成',
          );
          return;
        }
        if (action === 'git') {
          this.#assertFileSharingEnabled();
          if (!binding.cwd) throw new Error('このタスクには取得できるプロジェクトフォルダがありません。');
          await this.#showConfirmation(
            interaction,
            { type: 'gitArchive', threadId },
            [
              `プロジェクト直下の \`${truncate(path.join(binding.cwd, '.git'), 1200)}\` だけをタスクチャンネルへ投稿しますか？`,
              'Git履歴、remote URL、設定、hooks、資格情報を含む可能性があります。作業ツリーの通常ファイルは含めません。',
              projectArchiveVolumeText(this.config),
              '.git内のsymlink・junction・特殊ファイルはプロジェクト外参照を防ぐため含めません。',
            ].join('\n'),
            '.gitを作成',
          );
          return;
        }
        if (action === 'archive') {
          await interaction.deferReply({ ephemeral: true });
          if (binding.archived) {
            await this.codex.unarchiveThread(threadId);
            await this.codex.resumeThread(threadId);
            this.stateStore.setBinding(threadId, { archived: false });
          } else {
            await this.codex.archiveThread(threadId);
            await this.codex.unsubscribeThread(threadId);
            this.stateStore.setBinding(threadId, { archived: true });
          }
          await this.#syncAllTasks();
          const updated = this.stateStore.binding(threadId);
          await interaction.editReply(`${binding.archived ? '復元' : 'アーカイブ'}しました: ${channelMention(updated.channelId)}`);
          return;
        }
        return;
      }
      return;
    }
    if (parts[1] === 'ctl') {
      const action = parts[2];
      const threadId = parts[3];
      this.#assertTaskPanelInteraction(interaction, threadId);
      if (action === 'back') {
        await interaction.deferUpdate();
        await this.#showTaskControls(interaction, threadId);
        return;
      }
      if (action === 'goalset') {
        await this.#showGoalModal(interaction, threadId);
        return;
      }
      if (action === 'goalclear') {
        await interaction.deferUpdate();
        await this.#showConfirmation(
          interaction,
          { type: 'goalclear', threadId },
          'このタスクのgoalを解除しますか？',
          'Goalを解除',
        );
        return;
      }
      return;
    }
    if (parts[1] === 'confirm') {
      const action = this.pendingActions.get(parts[2]);
      if (!action || action.userId !== interaction.user.id) throw new Error('確認操作は期限切れです。');
      this.pendingActions.delete(parts[2]);
      if (parts[3] === 'no') {
        await interaction.update({ content: '操作を取り消しました。', embeds: [], components: [] });
        return;
      }
      await interaction.deferUpdate();
      if (action.type === 'permission') {
        await this.#applyThreadSettings(action.threadId, { permissions: action.profile });
        await this.#showTaskControls(interaction, action.threadId);
        return;
      }
      if (action.type === 'compact') {
        await this.codex.compactThread(action.threadId);
        await interaction.editReply({ content: 'Context compactを開始しました。', embeds: [], components: [] });
        return;
      }
      if (action.type === 'fork') {
        const result = await this.codex.forkThread(action.threadId, action.lastTurnId);
        const channel = await this.#openTaskChannel(result.thread);
        await interaction.editReply({
          content: `Forkしました: ${channelMention(channel.id)} / task \`${result.thread.id}\``,
          embeds: [],
          components: [],
        });
        return;
      }
      if (action.type === 'goalclear') {
        await this.codex.clearGoal(action.threadId);
        await interaction.editReply(goalPayload(action.threadId, null));
        return;
      }
      if (action.type === 'terminal') {
        const result = await this.codex.terminateBackgroundTerminal(action.threadId, action.processId);
        const terminals = await this.codex.listBackgroundTerminals(action.threadId);
        const payload = terminalPayload(action.threadId, terminals);
        payload.content = result.terminated ? `Terminal \`${action.processId}\` を終了しました。` : `Terminal \`${action.processId}\` は既に停止しています。`;
        await interaction.editReply(payload);
        return;
      }
      if (action.type === 'projectArchive') {
        const binding = this.#assertTaskPanelInteraction(interaction, action.threadId);
        const channel = interaction.channel ?? await this.client.channels.fetch(binding.channelId);
        await interaction.editReply({ content: 'プロジェクトarchiveを作成しています...', embeds: [], components: [] });
        const url = await this.#sendProjectArchive(channel, binding, interaction.user.id);
        await interaction.editReply({
          content: `プロジェクトarchiveを投稿しました: ${url}`,
          embeds: [],
          components: [],
        });
        return;
      }
      if (action.type === 'gitArchive') {
        const binding = this.#assertTaskPanelInteraction(interaction, action.threadId);
        const channel = interaction.channel ?? await this.client.channels.fetch(binding.channelId);
        await interaction.editReply({ content: '.git archiveを作成しています...', embeds: [], components: [] });
        const url = await this.#sendGitArchive(channel, binding, interaction.user.id);
        await interaction.editReply({
          content: `.git archiveを投稿しました: ${url}`,
          embeds: [],
          components: [],
        });
        return;
      }
      if (action.type === 'recentHistoryRestore') {
        if (this.recentHistoryRestorePromise) {
          const running = this.recentHistoryRestoreJob;
          await interaction.editReply({
            content: `履歴復元は既に実行中です（過去${running?.days ?? '?'}日 / ${running?.processed ?? 0}/${running?.total ?? '?'}タスク）。`,
            embeds: [],
            components: [],
          });
          return;
        }
        const job = this.#startRecentHistoryRestore(action.days, interaction.user.id);
        await interaction.editReply({
          content: `過去${job.days}日分の履歴復元を開始しました。Discord管理対象の全ての非アーカイブタスクを処理し、完了結果をCodex Remoteへ投稿します。`,
          embeds: [],
          components: [],
        });
        return;
      }
      if (action.type === 'projectVisibility') {
        const project = action.project;
        if (action.hidden) {
          this.stateStore.setHiddenProject(project.projectKey, {
            projectId: project.projectId,
            path: project.path,
            name: project.name,
            hiddenBy: interaction.user.id,
          });
        } else {
          this.stateStore.removeHiddenProject(project.projectKey);
        }
        await interaction.editReply({
          content: action.hidden
            ? `**${project.name}** のDiscordミラーを削除しています...`
            : `**${project.name}** のDiscordミラーを再作成しています...`,
          embeds: [],
          components: [],
        });
        const runningSync = this.taskSyncPromise;
        if (runningSync) await runningSync;
        const result = await this.#syncAllTasks();
        const completed = result.failed === 0;
        await interaction.editReply({
          content: action.hidden
            ? completed
              ? `**${project.name}** をDiscordで非表示にしました。削除 ${result.deleted ?? 0} / 失敗 0`
              : `**${project.name}** の非表示設定は保存しましたが、Discord削除が未完了です。削除 ${result.deleted ?? 0} / 失敗 ${result.failed}。自動同期で再試行します。`
            : completed
              ? `**${project.name}** をDiscordへ再表示しました。新規 ${result.created} / 移動 ${result.moved} / 失敗 0`
              : `**${project.name}** の再表示設定は保存しましたが、Discordミラーの再作成が未完了です。新規 ${result.created} / 移動 ${result.moved} / 失敗 ${result.failed}。自動同期で再試行します。`,
          embeds: [],
          components: [],
        });
        this.#log('project-visibility-changed', {
          projectKey: project.projectKey,
          projectId: project.projectId,
          hidden: action.hidden,
          userId: interaction.user.id,
          result,
        });
        return;
      }
      throw new Error(`Unknown confirmed action: ${action.type}`);
    }
    if (parts[1] === 'interrupt') {
      const action = this.pendingActions.get(parts[2]);
      if (!action || action.userId !== interaction.user.id || action.type !== 'interrupt') {
        throw new Error('中断確認は期限切れです。');
      }
      this.pendingActions.delete(parts[2]);
      if (parts[3] === 'no') {
        await interaction.update({ content: '中断を取り消しました。', components: [] });
        return;
      }
      await interaction.deferUpdate();
      const result = await this.codex.interrupt(action.threadId);
      await interaction.editReply({ content: `中断要求を送信しました: turn \`${result.turnId}\``, components: [] });
      return;
    }

    if (parts[1] !== 'req') return;
    const key = parts[2];
    const action = parts[3];
    const record = this.pendingRequests.get(key);
    this.#assertPendingRequest(record);

    if (action === 'toolModal') {
      const questions = record.request.params.questions;
      const modal = new ModalBuilder().setCustomId(`cx:input:${key}:tool`).setTitle('Codexへの回答');
      questions.slice(0, 5).forEach((question, index) => {
        modal.addComponents(userInputField(`q${index}`, question.header || question.question, { secret: question.isSecret }));
      });
      await interaction.showModal(modal);
      return;
    }
    if (action === 'mcpForm') {
      await this.#showMcpForm(interaction, key, record);
      return;
    }

    const result = this.#serverRequestResult(record, action);
    await interaction.deferUpdate();
    this.codex.respondToServerRequest(record.request.id, result);
    await this.#resolvePending(record, `Discordで回答: ${action}`, interaction.user.id);
  }

  async #handleModal(interaction) {
    const parts = interaction.customId.split(':');
    if (parts[0] !== 'cx') return;
    if (parts[1] === 'compose') {
      const action = this.pendingActions.get(parts[2]);
      if (!action || action.userId !== interaction.user.id || action.type !== 'compose') {
        throw new Error('入力画面は期限切れです。');
      }
      this.pendingActions.delete(parts[2]);
      await interaction.deferReply({ ephemeral: true });
      const prompt = interaction.fields.getTextInputValue('prompt');
      const mirror = this.#reserveUserInput(
        action.threadId,
        prompt,
        `Discord: ${interaction.user.tag}`,
        { executorUserId: interaction.user.id },
      );
      let result;
      try {
        result = await this.codex[action.mode](
          action.threadId,
          prompt,
          null,
          mirror.clientUserMessageId,
        );
      } catch (error) {
        this.#removeUserInputReservation(mirror);
        throw error;
      }
      mirror.turnId ??= result.turnId;
      await this.#ensureReservedUserInputPosted(mirror).catch((error) => {
        this.#log('user-input-mirror-error', { threadId: action.threadId, source: mirror.source, error: error.message });
      });
      await this.#moveLiveCardAfterReservedInput(mirror);
      await interaction.editReply(`受理されました: **${result.mode}** / turn \`${result.turnId ?? 'pending'}\``);
      return;
    }

    if (parts[1] === 'goal') {
      const action = this.pendingActions.get(parts[2]);
      if (!action || action.userId !== interaction.user.id || action.type !== 'goalset') {
        throw new Error('Goal入力画面は期限切れです。');
      }
      this.pendingActions.delete(parts[2]);
      await interaction.deferReply({ ephemeral: true });
      const objective = interaction.fields.getTextInputValue('objective').trim();
      const budgetText = interaction.fields.getTextInputValue('budget').trim();
      const tokenBudget = budgetText ? Number.parseInt(budgetText, 10) : null;
      if (!objective) throw new Error('Goal objectiveは空にできません。');
      if (budgetText && (!Number.isSafeInteger(tokenBudget) || tokenBudget <= 0 || String(tokenBudget) !== budgetText)) {
        throw new Error('Token budgetは正の整数で指定してください。');
      }
      const result = await this.codex.setGoal(action.threadId, objective, tokenBudget);
      await interaction.editReply(goalPayload(action.threadId, result.goal));
      return;
    }

    if (parts[1] === 'review') {
      const action = this.pendingActions.get(parts[2]);
      if (!action || action.userId !== interaction.user.id || action.type !== 'review') {
        throw new Error('Review入力画面は期限切れです。');
      }
      this.pendingActions.delete(parts[2]);
      await interaction.deferReply({ ephemeral: true });
      const value = interaction.fields.getTextInputValue('value');
      const result = await this.#startReview(action.threadId, action.kind, value, action.delivery);
      await interaction.editReply(result.text);
      return;
    }

    if (parts[1] !== 'input') return;
    const key = parts[2];
    const mode = parts[3];
    const record = this.pendingRequests.get(key);
    this.#assertPendingRequest(record);
    await interaction.deferReply({ ephemeral: true });

    let result;
    if (mode === 'tool') {
      const answers = {};
      record.request.params.questions.slice(0, 5).forEach((question, index) => {
        answers[question.id] = { answers: [interaction.fields.getTextInputValue(`q${index}`)] };
      });
      result = { answers };
    } else if (mode === 'toolq') {
      const index = Number.parseInt(parts[4], 10);
      const question = record.request.params.questions[index];
      record.answers[question.id] = { answers: [interaction.fields.getTextInputValue('answer')] };
      const complete = record.request.params.questions.every((candidate) => record.answers[candidate.id]);
      if (!complete) {
        await interaction.editReply('回答を保存しました。残りの質問にも回答してください。');
        return;
      }
      result = { answers: record.answers };
    } else if (mode === 'mcp') {
      result = { action: 'accept', content: this.#readMcpModal(interaction, record) };
    } else {
      throw new Error(`Unknown modal mode: ${mode}`);
    }

    this.codex.respondToServerRequest(record.request.id, result);
    await this.#resolvePending(record, 'Discordの入力を送信', interaction.user.id);
    await interaction.editReply('Codexへ回答しました。');
  }

  #resolveThreadId(interaction) {
    const explicit = interaction.options.getString('task');
    const binding = this.stateStore.bindingByChannel(interaction.channelId);
    if (explicit) {
      this.#assertThreadAccess(interaction, explicit);
      return explicit;
    }
    if (!binding) throw new Error('taskを指定するか、タスク専用チャンネルで実行してください。');
    return binding.threadId;
  }

  #assertThreadAccess(interaction, threadId) {
    const directBinding = this.stateStore.binding(threadId);
    if (this.#isBindingHidden(directBinding)) {
      throw new Error('このプロジェクトはDiscordで非表示です。Codex Remoteの「プロジェクト表示」から再表示してください。');
    }
    if (this.#isAuthorizedUser(interaction.user.id)) return;
    const binding = this.stateStore.bindingByChannel(interaction.channelId);
    if (!binding || binding.threadId !== threadId) {
      throw new Error('Discordで権限を持つ現在のタスク以外は操作できません。');
    }
  }

  #assertControlOperator(interaction) {
    if (!this.#isAuthorizedUser(interaction.user.id)) {
      throw new Error('この操作にはCodex Remote制御者権限が必要です。');
    }
  }

  #isSyncableThread(thread) {
    return Boolean(thread?.id) && !thread.ephemeral && !thread.parentThreadId;
  }

  #startTaskSyncPolling() {
    if (this.stopping || this.taskSyncTimer) return;
    const run = () => {
      if (this.stopping || !this.codex.connected) return;
      this.#syncAllTasks().then((result) => {
        if (result.created > 0 || result.moved > 0) {
          postTaskSyncSummary(this.client, this.stateStore, result).catch(() => {});
        }
      }).catch((error) => {
        this.#log('task-sync-error', { error: error.stack ?? error.message });
        this.#postAlert(`全タスク同期に失敗しました。\n${error.message}`, 'error').catch(() => {});
      });
    };
    this.taskSyncTimer = setInterval(run, this.config.taskSyncIntervalMs);
    this.taskSyncTimer.unref?.();
    this.taskSyncInitialTimer = setTimeout(() => {
      this.taskSyncInitialTimer = null;
      run();
    }, 5_000);
    this.taskSyncInitialTimer.unref?.();
  }

  async #syncAllTasks() {
    if (this.taskSyncPromise) return this.taskSyncPromise;
    this.taskSyncPromise = this.#performTaskSync();
    try {
      return await this.taskSyncPromise;
    } finally {
      this.taskSyncPromise = null;
    }
  }

  async #performTaskSync() {
    if (this.pendingChannelBindings.size > 0) {
      await Promise.allSettled([...this.pendingChannelBindings.values()]);
    }
    const [activeThreads, archivedThreads] = await Promise.all([
      this.codex.listAllThreads({ archived: false }),
      this.codex.listAllThreads({ archived: true }),
    ]);
    const syncableActive = activeThreads.filter((thread) => this.#isSyncableThread(thread));
    const syncableArchived = archivedThreads.filter((thread) => this.#isSyncableThread(thread));
    const { guild, controlCategory, completions } = await this.infrastructureReady;
    const channels = await guild.channels.fetch();
    const context = {
      guild,
      controlCategory,
      completions,
      channels,
      desktopProjects: readDesktopProjectSnapshot(this.config.desktopGlobalStatePath),
    };
    const classified = (threads) => threads.map((thread) => {
      const project = projectDescriptorForThread(
        thread,
        context.desktopProjects,
        this.config.projectCategoryPrefix,
      );
      return {
        thread,
        project,
        hiddenProject: this.#hiddenProjectDescriptorForThread(thread, project),
      };
    });
    const activeEntries = classified(syncableActive);
    const archivedEntries = classified(syncableArchived);
    const active = activeEntries.filter((entry) => !entry.hiddenProject)
      .map((entry) => entry.thread);
    const archived = archivedEntries.filter((entry) => !entry.hiddenProject)
      .map((entry) => entry.thread);
    const hiddenEntries = [...activeEntries.map((entry) => ({ ...entry, archived: false })),
      ...archivedEntries.map((entry) => ({ ...entry, archived: true }))]
      .filter((entry) => entry.hiddenProject);
    context.completionMessages = hiddenEntries.length > 0
      ? await completions.messages.fetch({ limit: 100 }).catch(() => new Map())
      : new Map();
    const result = {
      active: active.length,
      archived: archived.length,
      hidden: hiddenEntries.length,
      created: 0,
      moved: 0,
      deleted: 0,
      completionNoticesDeleted: 0,
      existing: 0,
      failed: 0,
      removedEmptyCategories: 0,
      subagentsCreated: 0,
      subagentsExisting: 0,
      subagentsFailed: 0,
      channels: [],
    };

    const hiddenThreadIds = new Set();
    for (const entry of hiddenEntries) {
      hiddenThreadIds.add(entry.thread.id);
      try {
        const removed = await this.#removeHiddenTaskMirror(
          entry.thread,
          entry.archived,
          context,
          entry.hiddenProject,
        );
        result.deleted += removed.deleted;
        result.completionNoticesDeleted += removed.noticesDeleted;
      } catch (error) {
        result.failed += 1;
        this.#log('hidden-project-task-removal-error', {
          threadId: entry.thread.id,
          projectKey: entry.hiddenProject.key,
          archived: entry.archived,
          error: error.stack ?? error.message,
        });
      }
    }
    for (const binding of this.stateStore.bindings?.({ includeHidden: true }) ?? []) {
      if (hiddenThreadIds.has(binding.threadId) || !this.#isProjectHidden(binding.projectKey)) continue;
      try {
        const removed = await this.#removeStaleHiddenBindingMirror(binding, context);
        result.deleted += removed.deleted;
        result.completionNoticesDeleted += removed.noticesDeleted;
      } catch (error) {
        result.failed += 1;
        this.#log('hidden-project-stale-binding-removal-error', {
          threadId: binding.threadId,
          projectKey: binding.projectKey,
          error: error.stack ?? error.message,
        });
      }
    }
    try {
      result.deleted += await this.#deleteHiddenProjectCategories(context);
    } catch (error) {
      result.failed += 1;
      this.#log('hidden-project-category-removal-error', { error: error.stack ?? error.message });
    }

    const syncThreads = async (threads, isArchived) => {
      let nextIndex = 0;
      const worker = async () => {
        while (nextIndex < threads.length) {
          const thread = threads[nextIndex];
          nextIndex += 1;
          try {
            const synced = await this.#syncTaskChannel(thread, isArchived, context);
            if (synced.created) {
              result.created += 1;
              result.channels.push(synced.channel.id);
            } else {
              result.existing += 1;
            }
            if (synced.moved) result.moved += 1;
          } catch (error) {
            result.failed += 1;
            this.#log('task-sync-thread-error', {
              threadId: thread.id,
              archived: isArchived,
              cwd: thread.cwd,
              error: error.stack ?? error.message,
            });
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(4, threads.length) }, () => worker()));
    };

    for (const [threads, isArchived] of [[active, false], [archived, true]]) {
      await syncThreads(threads, isArchived);
    }
    const subagents = await this.#syncSubagentsForTasks(active);
    result.subagentsCreated = subagents.created;
    result.subagentsExisting = subagents.existing;
    result.subagentsFailed = subagents.failed;
    context.channels = await guild.channels.fetch();
    result.removedEmptyCategories = await this.#cleanupEmptyManagedCategories(context);
    await this.#ensureControlPanel();
    this.#log('task-sync', result);
    return result;
  }

  #startRecentHistoryRestore(days, requestedBy) {
    if (this.recentHistoryRestorePromise) throw new Error('履歴復元は既に実行中です。');
    const job = {
      days,
      requestedBy,
      cutoffMs: recentHistoryCutoffMs(days),
      startedAt: Date.now(),
      total: 0,
      processed: 0,
      failed: 0,
    };
    this.recentHistoryRestoreJob = job;
    const promise = this.#performRecentHistoryRestore(job);
    this.recentHistoryRestorePromise = promise;
    promise.catch((error) => {
      this.#log('recent-history-restore-failed', {
        days,
        requestedBy,
        error: error.stack ?? error.message,
      });
      this.#postAlert(`最近の履歴復元に失敗しました。\n${error.message}`, 'error').catch(() => {});
    }).finally(() => {
      if (this.recentHistoryRestorePromise === promise) {
        this.recentHistoryRestorePromise = null;
        this.recentHistoryRestoreJob = null;
      }
    });
    return job;
  }

  async #performRecentHistoryRestore(job) {
    const activeThreads = (await this.codex.listAllThreads({ archived: false }))
      .filter((thread) => this.#isSyncableThread(thread))
      .filter((thread) => {
        const binding = this.stateStore.binding(thread.id);
        return binding && !binding.archived && !this.#isBindingHidden(binding);
      });
    job.total = activeThreads.length;
    const result = {
      days: job.days,
      cutoffMs: job.cutoffMs,
      total: activeThreads.length,
      processed: 0,
      failed: 0,
      skipped: 0,
      turns: 0,
      commentary: 0,
      reasoning: 0,
    };

    for (const thread of activeThreads) {
      const binding = this.stateStore.binding(thread.id);
      try {
        const channel = await this.client.channels.fetch(binding.channelId);
        const restored = await this.#reconcileThreadTranscript(thread.id, {
          channel,
          recentSinceMs: job.cutoffMs,
          includeHistoricalDetails: true,
        });
        if ((restored.restoredTurns ?? 0) > 0) {
          await this.#repostTaskPanelAfterTranscript(restored.thread, channel, false);
        }
        result.processed += 1;
        result.turns += restored.restoredTurns ?? 0;
        result.commentary += restored.restoredCommentary ?? 0;
        result.reasoning += restored.restoredReasoning ?? 0;
      } catch (error) {
        result.failed += 1;
        this.#log('recent-history-restore-thread-failed', {
          threadId: thread.id,
          days: job.days,
          error: error.stack ?? error.message,
        });
      } finally {
        job.processed += 1;
        job.failed = result.failed;
      }
    }

    const channelId = this.stateStore.snapshot().infrastructure.controlChannelId;
    const control = channelId ? await this.client.channels.fetch(channelId).catch(() => null) : null;
    if (control) {
      await control.send(messageOptions([
        `最近の履歴復元が完了しました（過去${job.days}日）。`,
        `非アーカイブ ${result.total} / 完了 ${result.processed} / スキップ ${result.skipped} / 失敗 ${result.failed}`,
        `対象ターン ${result.turns} / commentary ${result.commentary} / 推論要約 ${result.reasoning}`,
      ].join('\n')));
    }
    this.#log('recent-history-restore-completed', {
      ...result,
      requestedBy: job.requestedBy,
      elapsedMs: Date.now() - job.startedAt,
    });
    return result;
  }

  #panelMarker(message) {
    return message?.embeds?.map((embed) => embed.footer?.text).find(Boolean) ?? null;
  }

  #panelMessageMatches(message, payload) {
    const normalizeEmbed = (embed) => {
      const value = typeof embed?.toJSON === 'function' ? embed.toJSON() : embed ? { ...embed } : null;
      if (!value) return value;
      delete value.type;
      delete value.content_scan_version;
      value.fields = value.fields?.map((field) => {
        if (field.inline !== false) return field;
        const normalized = { ...field };
        delete normalized.inline;
        return normalized;
      });
      return value;
    };
    const componentData = (component) => (typeof component?.toJSON === 'function' ? component.toJSON() : component);
    return message.content === (payload.content ?? '')
      && isDeepStrictEqual((message.embeds ?? []).map(normalizeEmbed), (payload.embeds ?? []).map(normalizeEmbed))
      && isDeepStrictEqual((message.components ?? []).map(componentData), (payload.components ?? []).map(componentData));
  }

  async #ensurePanelMessage({
    key,
    channel,
    storedId,
    marker,
    payload,
    persist,
    pin = true,
    keepLatest = false,
  }) {
    const previous = this.panelSyncPromises.get(key) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(async () => {
      let message = storedId ? await channel.messages.fetch(storedId).catch(() => null) : null;
      if (message && this.#panelMarker(message) !== marker) message = null;
      if (!message && typeof channel.messages.fetchPinned === 'function') {
        const pinned = await channel.messages.fetchPinned().catch(() => null);
        message = pinned
          ? [...pinned.values()].find((candidate) => candidate.author.id === this.client.user.id
            && this.#panelMarker(candidate) === marker) ?? null
          : null;
      }
      if (!message) {
        const recent = await channel.messages.fetch({ limit: 100 }).catch(() => null);
        message = recent
          ? [...recent.values()].find((candidate) => candidate.author.id === this.client.user.id
            && this.#panelMarker(candidate) === marker) ?? null
          : null;
      }
      let superseded = null;
      if (message && keepLatest) {
        const recent = await channel.messages.fetch({ limit: 1 }).catch(() => null);
        const latest = recent?.first?.() ?? [...(recent?.values?.() ?? [])][0] ?? null;
        if (latest && latest.id !== message.id) {
          superseded = message;
          message = latest.author.id === this.client.user.id && this.#panelMarker(latest) === marker
            ? latest
            : null;
        }
      }
      if (!message) message = await channel.send(payload);
      else if (!this.#panelMessageMatches(message, payload)) await message.edit(payload);
      if (pin && this.canPinControlPanels && !message.pinned && typeof message.pin === 'function') {
        await message.pin('Keep Codex Remote controls available').catch((error) => {
          this.#log('control-panel-pin-failed', { channelId: channel.id, messageId: message.id, error: error.message });
        });
      }
      if (!pin && message.pinned && typeof message.unpin === 'function') {
        await message.unpin('Keep the latest Codex Remote control card unpinned').catch((error) => {
          this.#log('control-panel-unpin-failed', { channelId: channel.id, messageId: message.id, error: error.message });
        });
      }
      if (storedId !== message.id) persist(message.id);
      if (superseded && superseded.id !== message.id && superseded.author.id === this.client.user.id) {
        if (superseded.pinned && typeof superseded.unpin === 'function') {
          await superseded.unpin('Replace the Codex Remote control card at the latest position').catch((error) => {
            this.#log('control-panel-unpin-failed', {
              channelId: channel.id,
              messageId: superseded.id,
              error: error.message,
            });
          });
        }
        await superseded.delete().catch(async (error) => {
          if (error.code === 10008) return;
          await superseded.edit({ components: [] }).catch(() => {});
          this.#log('superseded-control-panel-delete-failed', {
            channelId: channel.id,
            messageId: superseded.id,
            error: error.message,
          });
        });
      }
      return message;
    });
    this.panelSyncPromises.set(key, operation);
    try {
      return await operation;
    } finally {
      if (this.panelSyncPromises.get(key) === operation) this.panelSyncPromises.delete(key);
    }
  }

  async #ensureControlPanel() {
    const infrastructure = await this.infrastructureReady;
    const state = this.stateStore.snapshot();
    const projects = this.#projectVisibilityProjects();
    const payload = controlPanelPayload({
      bindings: this.stateStore.bindings(),
      connected: this.codex.connected,
      pendingCount: this.#visiblePendingRequestCount(),
      projectCount: projects.filter((project) => !project.hidden).length,
      hiddenProjectCount: projects.filter((project) => project.hidden).length,
    });
    return this.#ensurePanelMessage({
      key: 'control',
      channel: infrastructure.control,
      storedId: state.infrastructure.controlPanelMessageId,
      marker: CONTROL_PANEL_MARKER,
      payload,
      persist: (messageId) => this.stateStore.setInfrastructure({ controlPanelMessageId: messageId }),
      pin: false,
      keepLatest: true,
    });
  }

  async #ensureTaskPanel(thread, channel, archived = false) {
    const binding = this.stateStore.binding(thread.id);
    if (!binding) return null;
    const effectiveBinding = { ...binding, archived };
    const payload = taskPanelPayload({ thread, binding: effectiveBinding });
    return this.#ensurePanelMessage({
      key: `task:${thread.id}`,
      channel,
      storedId: binding.controlPanelMessageId,
      marker: taskPanelMarker(thread.id),
      payload,
      persist: (messageId) => this.stateStore.setBinding(thread.id, { controlPanelMessageId: messageId }),
      pin: false,
    });
  }

  async #repostTaskPanelAfterTranscript(thread, channel, archived = false) {
    const key = `task:${thread.id}`;
    const previous = this.panelSyncPromises.get(key) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(async () => {
      const binding = this.stateStore.binding(thread.id);
      if (!binding) return null;
      const marker = taskPanelMarker(thread.id);
      let oldPanel = binding.controlPanelMessageId
        ? await channel.messages.fetch(binding.controlPanelMessageId).catch(() => null)
        : null;
      if (oldPanel && this.#panelMarker(oldPanel) !== marker) oldPanel = null;

      const newPanel = await channel.send(taskPanelPayload({
        thread,
        binding: { ...binding, archived },
      }));
      this.stateStore.setBinding(thread.id, { controlPanelMessageId: newPanel.id });
      if (oldPanel && oldPanel.id !== newPanel.id && oldPanel.author.id === this.client.user.id) {
        if (oldPanel.pinned && typeof oldPanel.unpin === 'function') {
          await oldPanel.unpin('Replace the Codex task control card without a pin').catch((error) => {
            this.#log('control-panel-unpin-failed', {
              channelId: channel.id,
              messageId: oldPanel.id,
              error: error.message,
            });
          });
        }
        await oldPanel.delete().catch(async (error) => {
          if (error.code === 10008) return;
          await oldPanel.edit({ components: [] }).catch(() => {});
          if (oldPanel.pinned && typeof oldPanel.unpin === 'function') await oldPanel.unpin().catch(() => {});
          this.#log('superseded-task-panel-delete-failed', {
            channelId: channel.id,
            messageId: oldPanel.id,
            error: error.message,
          });
        });
      }
      return newPanel;
    });
    this.panelSyncPromises.set(key, operation);
    try {
      return await operation;
    } finally {
      if (this.panelSyncPromises.get(key) === operation) this.panelSyncPromises.delete(key);
    }
  }

  async #repostTaskPanelAfterCompletion(threadId, turnId, channel) {
    const key = `task:${threadId}`;
    const previous = this.panelSyncPromises.get(key) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(async () => {
      const binding = this.stateStore.binding(threadId);
      if (!binding || binding.lastPanelCompletionTurnId === turnId) return null;
      const marker = taskPanelMarker(threadId);
      let oldPanel = binding.controlPanelMessageId
        ? await channel.messages.fetch(binding.controlPanelMessageId).catch(() => null)
        : null;
      if (oldPanel && this.#panelMarker(oldPanel) !== marker) oldPanel = null;
      if (!oldPanel && typeof channel.messages.fetchPinned === 'function') {
        const pinned = await channel.messages.fetchPinned().catch(() => null);
        oldPanel = pinned
          ? [...pinned.values()].find((candidate) => candidate.author.id === this.client.user.id
            && this.#panelMarker(candidate) === marker) ?? null
          : null;
      }

      const completedBinding = { ...binding, taskStatus: 'idle' };
      const thread = this.#threadFromBinding(completedBinding);
      const newPanel = await channel.send(taskPanelPayload({ thread, binding: completedBinding }));
      this.stateStore.setBinding(threadId, {
        controlPanelMessageId: newPanel.id,
        lastPanelCompletionTurnId: turnId,
        taskStatus: 'idle',
      });
      if (oldPanel && oldPanel.id !== newPanel.id && oldPanel.author.id === this.client.user.id) {
        if (oldPanel.pinned && typeof oldPanel.unpin === 'function') {
          await oldPanel.unpin('Replace the Codex task control card without a pin').catch((error) => {
            this.#log('control-panel-unpin-failed', {
              channelId: channel.id,
              messageId: oldPanel.id,
              error: error.message,
            });
          });
        }
        await oldPanel.delete().catch(async (error) => {
          if (error.code === 10008) return;
          await oldPanel.edit({ components: [] }).catch(() => {});
          if (oldPanel.pinned && typeof oldPanel.unpin === 'function') await oldPanel.unpin().catch(() => {});
          this.#log('superseded-task-panel-delete-failed', {
            channelId: channel.id,
            messageId: oldPanel.id,
            error: error.message,
          });
        });
      }
      return newPanel;
    });
    this.panelSyncPromises.set(key, operation);
    try {
      return await operation;
    } finally {
      if (this.panelSyncPromises.get(key) === operation) this.panelSyncPromises.delete(key);
    }
  }

  #projectCategoryNames(descriptor, count = 1) {
    return managedProjectCategoryNames(descriptor, this.stateStore.projectCategories(), count);
  }

  async #projectCategories(thread, context) {
    const descriptor = projectDescriptorForThread(
      thread,
      context.desktopProjects,
      this.config.projectCategoryPrefix,
    );
    const pending = this.projectCategoryPromises.get(descriptor.key);
    if (pending) return pending;
    const operation = this.#ensureProjectCategories(descriptor, context);
    this.projectCategoryPromises.set(descriptor.key, operation);
    try {
      return await operation;
    } finally {
      if (this.projectCategoryPromises.get(descriptor.key) === operation) {
        this.projectCategoryPromises.delete(descriptor.key);
      }
    }
  }

  async #ensureProjectCategories(descriptor, context) {
    const stored = this.stateStore.projectCategory(descriptor.key);
    const desiredBaseName = this.#projectCategoryNames(descriptor)[0];
    const categories = [];
    for (const categoryId of stored?.categoryIds ?? []) {
      const category = context.channels.get(categoryId)
        ?? await this.client.channels.fetch(categoryId).catch(() => null);
      if (category?.type !== ChannelType.GuildCategory) continue;
      context.channels.set(category.id, category);
      categories.push(category);
    }
    if (categories.length === 0) {
      const name = desiredBaseName;
      let category = context.channels.find((channel) => channel?.type === ChannelType.GuildCategory
        && channel.name === name);
      let categoryCreated = false;
      if (!category) {
        category = await context.guild.channels.create({ name, type: ChannelType.GuildCategory });
        categoryCreated = true;
      }
      context.channels.set(category.id, category);
      if (categoryCreated) {
        await this.#copyCategoryPermissions(context.controlCategory, category, context.guild);
      }
      categories.push(category);
    }
    const desiredNames = this.#projectCategoryNames(descriptor, categories.length);
    for (let index = 0; index < categories.length; index += 1) {
      const category = categories[index];
      const desiredName = desiredNames[index];
      if (category.name === desiredName) continue;
      const renamed = await category.setName(desiredName, 'Refresh Codex project category name');
      categories[index] = renamed ?? category;
      context.channels.set(categories[index].id, categories[index]);
    }
    this.stateStore.setProjectCategory(descriptor.key, {
      projectId: descriptor.id,
      path: descriptor.path,
      name: categories[0].name,
      categoryIds: categories.map((category) => category.id),
    });
    return { descriptor, categories };
  }

  async #archiveCategories(context) {
    const infrastructure = this.stateStore.snapshot().infrastructure;
    const categories = (infrastructure.archiveCategoryIds ?? [])
      .map((categoryId) => context.channels.get(categoryId))
      .filter((channel) => channel?.type === ChannelType.GuildCategory);
    if (categories.length > 0) return categories;
    let category = context.channels.find((channel) => channel?.type === ChannelType.GuildCategory
      && channel.name === this.config.archiveCategoryName);
    if (!category) {
      category = await context.guild.channels.create({
        name: this.config.archiveCategoryName,
        type: ChannelType.GuildCategory,
      });
    }
    context.channels.set(category.id, category);
    await this.#configurePrivateCategory(category, context.guild);
    this.stateStore.setInfrastructure({ archiveCategoryIds: [category.id] });
    return [category];
  }

  async #categoryWithCapacity(categories, baseName, existingParentId, context, onCreate) {
    const existing = categories.find((category) => category.id === existingParentId);
    if (existing) return existing;
    const available = categories.find((category) => category.children.cache.size < 50);
    if (available) return available;
    const category = await context.guild.channels.create({
      name: truncate(`${baseName} (${categories.length + 1})`, 100, ''),
      type: ChannelType.GuildCategory,
    });
    await this.#copyCategoryPermissions(categories[0], category, context.guild);
    context.channels.set(category.id, category);
    categories.push(category);
    await onCreate(categories.map((candidate) => candidate.id));
    return category;
  }

  async #targetCategory(thread, archived, existingParentId, context) {
    const descriptor = projectDescriptorForThread(
      thread,
      context.desktopProjects,
      this.config.projectCategoryPrefix,
    );
    const hiddenProject = this.#hiddenProjectDescriptorForThread(thread, descriptor);
    if (hiddenProject) {
      throw new Error(`Project is hidden from Discord: ${hiddenProject.path}`);
    }
    if (archived) {
      const categories = await this.#archiveCategories(context);
      const category = await this.#categoryWithCapacity(
        categories,
        this.config.archiveCategoryName,
        existingParentId,
        context,
        async (categoryIds) => this.stateStore.setInfrastructure({ archiveCategoryIds: categoryIds }),
      );
      return {
        category,
        project: descriptor,
      };
    }
    const { descriptor: activeProject, categories } = await this.#projectCategories(thread, context);
    const category = await this.#categoryWithCapacity(
      categories,
      categories[0].name,
      existingParentId,
      context,
      async (categoryIds) => this.stateStore.setProjectCategory(activeProject.key, { categoryIds }),
    );
    return { category, project: activeProject };
  }

  async #deleteCompletionNoticesForBinding(binding, context) {
    if (!binding || !context.completions) return 0;
    const messageIds = new Set(Object.values(binding.turnMessages ?? {})
      .map((record) => record?.completionNoticeMessageId)
      .filter(Boolean));
    const channelMarker = binding.channelId
      ? `/channels/${this.config.guildId}/${binding.channelId}/`
      : null;
    for (const message of context.completionMessages?.values?.() ?? []) {
      if (message.author?.id !== this.client.user.id) continue;
      if (channelMarker && String(message.content ?? '').includes(channelMarker)) messageIds.add(message.id);
    }
    let deleted = 0;
    for (const messageId of messageIds) {
      const message = context.completionMessages?.get?.(messageId)
        ?? await context.completions.messages.fetch(messageId).catch(() => null);
      if (!message || message.author?.id !== this.client.user.id) continue;
      await message.delete();
      context.completionMessages?.delete?.(messageId);
      deleted += 1;
    }
    return deleted;
  }

  #clearHiddenTaskRuntime(threadId) {
    for (const [key, view] of this.turnViews) {
      if (view.threadId !== threadId) continue;
      if (view.timer) clearTimeout(view.timer);
      if (view.elapsedTimer) clearTimeout(view.elapsedTimer);
      this.turnViews.delete(key);
    }
    this.#clearCompletionRecovery(threadId, null);
  }

  async #waitForTaskMirrorOperations(threadId) {
    const prefix = `${threadId}:`;
    const pending = [
      this.notificationQueues.get(threadId),
      this.subscriptionSyncPromises.get(threadId),
      this.transcriptSyncPromises.get(threadId),
      this.panelSyncPromises.get(`task:${threadId}`),
      ...[...this.turnCompletionPromises]
        .filter(([key]) => key.startsWith(prefix))
        .map(([, promise]) => promise),
      ...[...this.completionNoticePromises]
        .filter(([key]) => key.startsWith(prefix))
        .map(([, promise]) => promise),
      ...[...this.liveCardMovePromises]
        .filter(([key]) => key.startsWith(prefix))
        .map(([, promise]) => promise),
    ].filter(Boolean);
    if (pending.length > 0) await Promise.allSettled([...new Set(pending)]);
    return pending.length;
  }

  async #removeHiddenTaskMirror(thread, archived, context, hiddenDescriptor = null) {
    const descriptor = hiddenDescriptor ?? this.#hiddenProjectDescriptorForThread(
      thread,
      projectDescriptorForThread(
        thread,
        context.desktopProjects,
        this.config.projectCategoryPrefix,
      ),
    );
    if (!descriptor) throw new Error(`No hidden project identity is available for task ${thread.id}.`);
    const waited = await this.#waitForTaskMirrorOperations(thread.id);
    if (waited > 0) {
      context.completionMessages = await context.completions.messages.fetch({ limit: 100 })
        .catch(() => context.completionMessages);
    }
    const existing = this.stateStore.binding(thread.id);
    let channel = existing?.channelId ? context.channels.get(existing.channelId) : null;
    if (!channel && existing?.channelId) {
      channel = await this.client.channels.fetch(existing.channelId).catch(() => null);
    }
    if (!channel) {
      channel = context.channels.find((candidate) => candidate?.type === ChannelType.GuildText
        && candidate.topic?.includes(`Codex task: ${thread.id}`));
    }
    const noticeCount = await this.#deleteCompletionNoticesForBinding(existing, context);
    let deleted = 0;
    if (channel) {
      await channel.delete('Remove the Discord mirror for a hidden Codex project');
      context.channels.delete(channel.id);
      deleted = 1;
    }
    for (const subagent of this.stateStore.subagentThreads?.() ?? []) {
      if (subagent.topLevelParentThreadId !== thread.id) continue;
      this.stateStore.removeSubagentThread(subagent.threadId);
    }
    this.#clearHiddenTaskRuntime(thread.id);
    this.stateStore.hideBinding(thread.id, {
      projectKey: descriptor.key,
      projectId: descriptor.id,
      archived,
      name: thread.name ?? thread.preview ?? existing?.name ?? null,
      taskStatus: thread.status?.type ?? existing?.taskStatus ?? 'unknown',
      cwd: thread.cwd ?? existing?.cwd ?? null,
      sessionPath: thread.path ?? existing?.sessionPath ?? null,
      watchLevel: existing?.watchLevel ?? this.config.defaultWatchLevel,
      completionReportsEnabled: existing?.completionReportsEnabled ?? true,
      lastCompletedTurnId: existing?.lastCompletedTurnId ?? null,
      lastNotifiedCompletedTurnId: existing?.lastNotifiedCompletedTurnId ?? null,
      runtimeSettings: existing?.runtimeSettings ?? null,
    });
    return { deleted, noticesDeleted: noticeCount, projectKey: descriptor.key };
  }

  async #removeStaleHiddenBindingMirror(binding, context) {
    const waited = await this.#waitForTaskMirrorOperations(binding.threadId);
    if (waited > 0) {
      context.completionMessages = await context.completions.messages.fetch({ limit: 100 })
        .catch(() => context.completionMessages);
    }
    binding = this.stateStore.binding(binding.threadId) ?? binding;
    let channel = binding.channelId ? context.channels.get(binding.channelId) : null;
    if (!channel && binding.channelId) {
      channel = await this.client.channels.fetch(binding.channelId).catch(() => null);
    }
    const noticeCount = await this.#deleteCompletionNoticesForBinding(binding, context);
    let deleted = 0;
    if (channel) {
      await channel.delete('Remove a stale Discord mirror for a hidden Codex project');
      context.channels.delete(channel.id);
      deleted = 1;
    }
    for (const subagent of this.stateStore.subagentThreads?.() ?? []) {
      if (subagent.topLevelParentThreadId !== binding.threadId) continue;
      this.stateStore.removeSubagentThread(subagent.threadId);
    }
    this.#clearHiddenTaskRuntime(binding.threadId);
    this.stateStore.hideBinding(binding.threadId, binding);
    return { deleted, noticesDeleted: noticeCount };
  }

  async #deleteHiddenProjectCategories(context) {
    const state = this.stateStore.snapshot();
    let deleted = 0;
    for (const projectKey of Object.keys(state.hiddenProjects ?? {})) {
      const project = state.projectCategories?.[projectKey];
      if (!project) continue;
      for (const categoryId of project.categoryIds ?? []) {
        const category = context.channels.get(categoryId)
          ?? await this.client.channels.fetch(categoryId).catch(() => null);
        if (!category || category.type !== ChannelType.GuildCategory) continue;
        for (const child of category.children?.cache?.values?.() ?? []) {
          if (!context.channels.has(child.id)) continue;
          const binding = this.stateStore.bindingByChannel(child.id);
          if (binding) {
            const removed = await this.#removeStaleHiddenBindingMirror(binding, context);
            deleted += removed.deleted;
          }
          else {
            await child.delete('Remove an unbound Discord channel in a hidden Codex project');
            context.channels.delete(child.id);
            deleted += 1;
          }
        }
        await category.delete('Remove the Discord category for a hidden Codex project');
        context.channels.delete(category.id);
        deleted += 1;
      }
      this.stateStore.removeProjectCategory(projectKey);
    }
    return deleted;
  }

  async #cleanupEmptyManagedCategories(context) {
    let state = this.stateStore.snapshot();
    const activeProjectKeys = new Set(Object.values(state.bindings ?? {})
      .filter((binding) => !binding.hidden
        && !binding.archived
        && binding.projectKey
        && !state.hiddenProjects?.[binding.projectKey])
      .map((binding) => binding.projectKey));
    let removed = 0;
    for (const [projectKey, project] of Object.entries(state.projectCategories ?? {})) {
      const categories = (project.categoryIds ?? [])
        .map((categoryId) => context.channels.get(categoryId))
        .filter((category) => category?.type === ChannelType.GuildCategory);
      const plan = managedProjectCategoryCleanupPlan(categories, activeProjectKeys.has(projectKey));
      for (const category of plan.remove) {
        await category.delete('Remove unused Codex project category after task synchronization');
        context.channels.delete(category.id);
        removed += 1;
      }
      if (plan.removeProject) {
        this.stateStore.removeProjectCategory(projectKey);
      } else if (plan.keep.length !== (project.categoryIds ?? []).length) {
        this.stateStore.setProjectCategory(projectKey, {
          categoryIds: plan.keep.map((category) => category.id),
        });
      }
    }

    state = this.stateStore.snapshot();
    const referencedIds = new Set([
      state.infrastructure.controlCategoryId,
      ...(state.infrastructure.archiveCategoryIds ?? []),
      ...Object.values(state.projectCategories ?? {}).flatMap((project) => project.categoryIds ?? []),
    ].filter(Boolean));
    const projectNames = new Set(Object.values(state.projectCategories ?? {}).map((project) => project.name));
    for (const category of context.channels.values()) {
      if (category?.type !== ChannelType.GuildCategory || referencedIds.has(category.id)) continue;
      const isDuplicateProject = projectNames.has(category.name);
      const isDuplicateArchive = category.name === this.config.archiveCategoryName
        || category.name.startsWith(`${this.config.archiveCategoryName} (`);
      if ((!isDuplicateProject && !isDuplicateArchive) || category.children.cache.size > 0) continue;
      await category.delete('Remove empty duplicate Codex category after task synchronization');
      context.channels.delete(category.id);
      removed += 1;
    }
    return removed;
  }

  async #syncTaskChannel(thread, archived, context) {
    const existingBinding = this.stateStore.binding(thread.id);
    let channel = existingBinding?.channelId ? context.channels.get(existingBinding.channelId) : null;
    if (!channel && existingBinding?.channelId) {
      channel = await this.client.channels.fetch(existingBinding.channelId).catch(() => null);
    }
    if (!channel) {
      channel = context.channels.find((candidate) => candidate?.type === ChannelType.GuildText
        && candidate.topic?.includes(`Codex task: ${thread.id}`));
    }

    const target = await this.#targetCategory(thread, archived, channel?.parentId, context);
    const workspace = projectDescriptor(thread.cwd, this.config.projectCategoryPrefix);
    const desiredName = taskChannelName(thread);
    const turnState = thread.status?.type === 'active' ? 'running' : 'stopped';
    const desiredTopic = truncate(
      `Codex project: ${workspace.id}\nCodex task: ${thread.id}\nProject: ${thread.cwd ?? '(none)'}\nState: ${archived ? 'archived' : 'active'}\nTurn: ${turnState}`,
      1024,
      '',
    );
    let created = false;
    let moved = false;
    if (!channel) {
      channel = await context.guild.channels.create({
        name: desiredName,
        type: ChannelType.GuildText,
        parent: target.category.id,
        topic: desiredTopic,
      });
      created = true;
    } else {
      if (channel.parentId !== target.category.id) {
        await this.#moveTaskChannel(channel, target.category.id, 'Reconcile Codex task category');
        moved = true;
      }
      if (channel.name !== desiredName || channel.topic !== desiredTopic) {
        this.#scheduleTaskChannelMetadata(
          channel,
          desiredName,
          desiredTopic,
          'Refresh Codex task metadata',
        );
      }
    }
    if (!channel.permissionsLocked) await channel.lockPermissions();

    await this.#bindChannel(thread, channel, {
      archived,
      categoryId: target.category.id,
      projectKey: target.project.key,
      projectId: target.project.id,
      subscribe: !archived && (!existingBinding || existingBinding.archived || existingBinding.hidden),
    });
    await this.#ensureTaskPanel(thread, channel, archived);
    const recoveryBinding = this.stateStore.binding(thread.id) ?? existingBinding;
    const incompleteTurnId = completionRecoveryCandidate(recoveryBinding);
    const completedDuringSyncId = recoveryBinding?.lastCompletedTurnId !== existingBinding?.lastCompletedTurnId
      ? recoveryBinding?.lastCompletedTurnId
      : null;
    const completedDuringSync = completedDuringSyncId
      ? this.stateStore.turnRecord(thread.id, completedDuringSyncId)
      : null;
    const staleActiveNeedsRecovery = existingBinding?.taskStatus === 'active'
      && !(completedDuringSync?.finalizedAt && completedDuringSync.finalMessageIds?.length > 0);
    if (!archived
      && thread.status?.type !== 'active'
      && (staleActiveNeedsRecovery || incompleteTurnId)) {
      this.#scheduleCompletionRecovery(
        thread.id,
        incompleteTurnId,
        'task-sync-detected-incomplete-completion',
        0,
      );
    }
    if (created || (existingBinding?.transcriptVersion ?? 0) < 11) {
      if (!this.transcriptSyncPromises.has(thread.id)) {
        this.#log('task-transcript-sync-scheduled', {
          threadId: thread.id,
          channelId: channel.id,
          created,
        });
        this.#reconcileThreadTranscript(thread.id, { channel, archived })
          .then(() => this.#repostTaskPanelAfterTranscript(thread, channel, archived))
          .catch(() => {});
      }
    }
    return { channel, created, moved };
  }

  async #syncSubagentsForTasks(parentThreads) {
    if (typeof this.stateStore.subagentThreads !== 'function') {
      return { created: 0, existing: 0, failed: 0 };
    }
    const childIds = new Set();
    const addChildId = (childId) => {
      if (!childId) return;
      if (shouldPeriodicallySyncSubagent(this.stateStore.subagentThread(childId))) {
        childIds.add(childId);
      }
    };
    for (const binding of this.stateStore.subagentThreads()) addChildId(binding.threadId);

    for (const parent of parentThreads) {
      const binding = this.stateStore.binding(parent.id);
      if (!binding) continue;
      const sourceUpdatedAt = parent.updatedAt ?? parent.recencyAt ?? null;
      if (binding.subagentScanVersion === 1
        && binding.subagentScanUpdatedAt === sourceUpdatedAt
        && Array.isArray(binding.subagentThreadIds)) {
        for (const childId of binding.subagentThreadIds) addChildId(childId);
        continue;
      }
      try {
        const hydrated = (await this.codex.readThread(parent.id)).thread;
        const discoveredIds = subagentIdsFromThread(hydrated);
        for (const childId of discoveredIds) addChildId(childId);
        this.stateStore.setBinding(parent.id, {
          subagentScanVersion: 1,
          subagentScanUpdatedAt: sourceUpdatedAt,
          subagentThreadIds: discoveredIds,
        });
      } catch (error) {
        this.#log('subagent-parent-scan-failed', {
          threadId: parent.id,
          error: error.stack ?? error.message,
        });
      }
    }

    const result = { created: 0, existing: 0, failed: 0 };
    let nextIndex = 0;
    const ids = [...childIds];
    const worker = async () => {
      while (nextIndex < ids.length) {
        const childId = ids[nextIndex];
        nextIndex += 1;
        const existed = Boolean(this.stateStore.subagentThread(childId)?.channelId);
        try {
          const binding = await this.#ensureSubagentBinding(childId, { force: true, activeOnly: true });
          if (!binding) continue;
          if (existed) result.existing += 1;
          else result.created += 1;
        } catch (error) {
          result.failed += 1;
          this.#log('subagent-sync-failed', {
            threadId: childId,
            error: error.stack ?? error.message,
          });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, ids.length) }, () => worker()));
    return result;
  }

  #rememberUnsyncedSubagent(thread) {
    const existing = this.stateStore.subagentThread(thread.id);
    const metadata = subagentMetadata(thread);
    this.stateStore.setSubagentThread(thread.id, {
      channelId: existing?.channelId ?? null,
      parentChannelId: existing?.parentChannelId ?? null,
      parentThreadId: metadata.parentThreadId,
      topLevelParentThreadId: existing?.topLevelParentThreadId ?? null,
      agentPath: metadata.agentPath,
      nickname: metadata.nickname,
      role: metadata.role,
      depth: metadata.depth,
      cwd: thread.cwd ?? existing?.cwd ?? null,
      sessionPath: thread.path ?? existing?.sessionPath ?? null,
      name: thread.name ?? metadata.nickname ?? metadata.agentPath ?? 'subagent',
      taskStatus: thread.status?.type ?? 'unknown',
      watchLevel: 'normal',
      completionReportsEnabled: false,
      discordArchived: existing?.discordArchived ?? true,
      snapshotInitialized: existing?.snapshotInitialized ?? false,
    });
  }

  async #ensureSubagentBinding(threadId, { force = false, activeOnly = false } = {}) {
    const existing = this.stateStore.binding(threadId);
    if (activeOnly && existing?.isSubagent && !shouldPeriodicallySyncSubagent(existing)) return null;
    if (!force && existing?.isSubagent && existing.channelId) return existing;
    const rejectedAt = this.nonSubagentThreadIds.get(threadId);
    if (!force && rejectedAt && Date.now() - rejectedAt < 300_000) return null;
    const pending = this.subagentSyncPromises.get(threadId);
    if (pending) return pending;
    const operation = (async () => {
      if (!existing?.isSubagent && typeof this.codex.threadMetadata === 'function') {
        const metadata = (await this.codex.threadMetadata(threadId))?.thread;
        if (!isSubagentCodexThread(metadata)) {
          this.nonSubagentThreadIds.set(threadId, Date.now());
          return null;
        }
        if (activeOnly && !isActiveSubagentThread(metadata)) {
          this.#rememberUnsyncedSubagent(metadata);
          return null;
        }
      }
      const result = await this.codex.readThread(threadId);
      const thread = result?.thread;
      if (!isSubagentCodexThread(thread)) {
        this.nonSubagentThreadIds.set(threadId, Date.now());
        return null;
      }
      if (activeOnly && !isActiveSubagentThread(thread)) {
        this.#rememberUnsyncedSubagent(thread);
        return null;
      }
      this.nonSubagentThreadIds.delete(threadId);
      return this.#syncSubagentThread(thread);
    })();
    this.subagentSyncPromises.set(threadId, operation);
    try {
      return await operation;
    } finally {
      if (this.subagentSyncPromises.get(threadId) === operation) {
        this.subagentSyncPromises.delete(threadId);
      }
    }
  }

  async #topLevelParentBinding(thread) {
    const { parentThreadId } = subagentMetadata(thread);
    if (!parentThreadId) return null;
    let parent = this.stateStore.binding(parentThreadId);
    if (parent?.isSubagent && !parent.topLevelParentThreadId) {
      const result = await this.codex.readThread(parentThreadId);
      parent = await this.#syncSubagentThread(result.thread);
    } else if (!parent) {
      const result = await this.codex.readThread(parentThreadId);
      if (isSubagentCodexThread(result.thread)) parent = await this.#syncSubagentThread(result.thread);
      else parent = this.stateStore.binding(parentThreadId);
    }
    if (!parent) return null;
    const topLevelParentThreadId = parent.isSubagent ? parent.topLevelParentThreadId : parent.threadId;
    const topLevel = this.stateStore.binding(topLevelParentThreadId);
    return topLevel && !topLevel.isSubagent ? topLevel : null;
  }

  async #findExistingDiscordSubagentThread(parentChannel, threadId, storedChannelId = null) {
    if (storedChannelId) {
      const stored = await this.client.channels.fetch(storedChannelId).catch(() => null);
      if (stored?.isThread?.() && stored.parentId === parentChannel.id) return stored;
    }
    const suffix = String(threadId).slice(-8);
    const active = await parentChannel.threads.fetchActive(false).catch(() => null);
    let match = active?.threads
      ? [...active.threads.values()].find((candidate) => candidate.name.endsWith(suffix)) ?? null
      : null;
    if (match) return match;
    const archived = await parentChannel.threads.fetchArchived({ type: 'public', limit: 100 }, false).catch(() => null);
    match = archived?.threads
      ? [...archived.threads.values()].find((candidate) => candidate.name.endsWith(suffix)) ?? null
      : null;
    return match;
  }

  async #ensureSubagentHeader(binding, thread, channel) {
    const metadata = subagentMetadata(thread);
    let message = binding.headerMessageId
      ? await channel.messages.fetch(binding.headerMessageId).catch(() => null)
      : null;
    if (!message) {
      const recent = await channel.messages.fetch({ limit: 100 }).catch(() => null);
      message = recent
        ? [...recent.values()].find((candidate) => candidate.author.id === this.client.user.id
          && candidate.embeds.some((embed) => embed.footer?.text === subagentMarker(thread.id))) ?? null
        : null;
    }
    const embed = new EmbedBuilder()
      .setTitle('Codex subagent')
      .setColor(thread.status?.type === 'active' ? COLORS.active : COLORS.neutral)
      .setDescription('親タスクから起動されたサブエージェントの閲覧専用ミラーです。')
      .addFields(
        { name: 'Agent', value: metadata.nickname ?? '(nicknameなし)', inline: true },
        { name: 'Path', value: `\`${metadata.agentPath ?? '(unknown)'}\``, inline: true },
        { name: 'Depth', value: String(metadata.depth ?? '?'), inline: true },
        { name: 'Agent thread', value: `\`${thread.id}\`` },
        { name: 'Parent task', value: `<#${binding.parentChannelId}> / \`${binding.topLevelParentThreadId}\`` },
      )
      .setFooter({ text: subagentMarker(thread.id) })
      .setTimestamp();
    const payload = { embeds: [embed], allowedMentions: { parse: [] } };
    if (message) await message.edit(payload);
    else message = await channel.send(payload);
    if (binding.headerMessageId !== message.id) {
      this.stateStore.setSubagentThread(thread.id, { headerMessageId: message.id });
    }
    return message;
  }

  async #syncSubagentThread(thread) {
    const metadata = subagentMetadata(thread);
    const topLevel = await this.#topLevelParentBinding(thread);
    if (!topLevel) {
      this.#scheduleTaskSync('subagent-parent-not-bound');
      return null;
    }
    if (this.#isBindingHidden(topLevel)) {
      if (this.stateStore.subagentThread?.(thread.id)) this.stateStore.removeSubagentThread(thread.id);
      return null;
    }
    const parentChannel = await this.client.channels.fetch(topLevel.channelId).catch(() => null);
    if (!parentChannel?.threads) throw new Error(`Parent task channel is unavailable: ${topLevel.channelId}`);
    const existing = this.stateStore.subagentThread(thread.id);
    let channel = await this.#findExistingDiscordSubagentThread(parentChannel, thread.id, existing?.channelId);
    let created = false;
    if (!channel) {
      channel = await parentChannel.threads.create({
        name: subagentDiscordThreadName(thread),
        autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
        type: ChannelType.PublicThread,
        reason: `Mirror Codex subagent ${thread.id}`,
      });
      created = true;
    }
    if (channel.archived) await channel.setArchived(false, 'Synchronize Codex subagent');
    const desiredName = subagentDiscordThreadName(thread);
    if (channel.name !== desiredName) await channel.setName(desiredName, 'Refresh Codex subagent status');
    this.stateStore.setSubagentThread(thread.id, {
      channelId: channel.id,
      parentChannelId: parentChannel.id,
      parentThreadId: metadata.parentThreadId,
      topLevelParentThreadId: topLevel.threadId,
      agentPath: metadata.agentPath,
      nickname: metadata.nickname,
      role: metadata.role,
      depth: metadata.depth,
      cwd: thread.cwd ?? topLevel.cwd ?? null,
      sessionPath: thread.path ?? existing?.sessionPath ?? null,
      name: thread.name ?? metadata.nickname ?? metadata.agentPath ?? 'subagent',
      taskStatus: thread.status?.type ?? 'unknown',
      watchLevel: 'normal',
      completionReportsEnabled: false,
      discordArchived: false,
      snapshotInitialized: existing?.snapshotInitialized ?? false,
    });
    let binding = this.stateStore.subagentThread(thread.id);
    await this.#ensureSubagentHeader(binding, thread, channel);
    binding = this.stateStore.subagentThread(thread.id);
    const needsTranscript = created || (binding.transcriptVersion ?? 0) < 11
      || subagentOwnTurns(thread).some((turn) => turn.status === 'inProgress');
    if (needsTranscript) {
      this.#reconcileThreadTranscript(thread.id, {
        channel,
        activeOnly: !created && (binding.transcriptVersion ?? 0) >= 11,
        includeHistoricalDetails: true,
      }).then(async () => {
        const latest = this.stateStore.subagentThread(thread.id);
        if (latest?.taskStatus !== 'active' && !channel.archived) {
          await channel.setArchived(true, 'Codex subagent is idle');
          this.stateStore.setSubagentThread(thread.id, { discordArchived: true });
        }
      }).catch((error) => {
        this.#log('subagent-transcript-sync-failed', {
          threadId: thread.id,
          channelId: channel.id,
          error: error.stack ?? error.message,
        });
      });
    } else if (thread.status?.type !== 'active') {
      await channel.setArchived(true, 'Codex subagent is idle');
      this.stateStore.setSubagentThread(thread.id, { discordArchived: true });
    }
    this.#log('subagent-thread-synced', {
      threadId: thread.id,
      parentThreadId: metadata.parentThreadId,
      topLevelParentThreadId: topLevel.threadId,
      channelId: channel.id,
      created,
      status: thread.status?.type ?? 'unknown',
    });
    return this.stateStore.subagentThread(thread.id);
  }

  #subagentThreadFromBinding(binding, status) {
    return {
      id: binding.threadId,
      status: { type: status },
      source: {
        subAgent: {
          thread_spawn: {
            parent_thread_id: binding.parentThreadId,
            depth: binding.depth,
            agent_path: binding.agentPath,
            agent_nickname: binding.nickname,
            agent_role: binding.role,
          },
        },
      },
    };
  }

  async #setSubagentDiscordStatus(binding, status) {
    if (!binding?.isSubagent) return;
    const channel = await this.client.channels.fetch(binding.channelId).catch(() => null);
    if (!channel?.isThread?.()) return;
    if (channel.archived) await channel.setArchived(false, 'Refresh Codex subagent status');
    const thread = this.#subagentThreadFromBinding(binding, status);
    const desiredName = subagentDiscordThreadName(thread);
    if (channel.name !== desiredName) await channel.setName(desiredName, 'Refresh Codex subagent status');
    await this.#ensureSubagentHeader(binding, thread, channel);
    const discordArchived = status !== 'active';
    if (discordArchived) await channel.setArchived(true, 'Codex subagent is idle');
    this.stateStore.setSubagentThread(binding.threadId, { taskStatus: status, discordArchived });
  }

  async #openTaskChannel(thread) {
    this.#assertThreadVisible(thread);
    const { guild } = await this.infrastructureReady;
    const context = {
      guild,
      channels: await guild.channels.fetch(),
      desktopProjects: readDesktopProjectSnapshot(this.config.desktopGlobalStatePath),
    };
    const archived = Boolean(this.stateStore.binding(thread.id)?.archived);
    const synced = await this.#syncTaskChannel(thread, archived, context);
    return synced.channel;
  }

  async #bindChannel(thread, channel, {
    archived = false, categoryId = channel.parentId, projectKey = null, projectId = null, subscribe = false,
  } = {}) {
    const colliding = this.stateStore.bindingByChannel(channel.id);
    if (colliding && colliding.threadId !== thread.id) this.stateStore.removeBinding(colliding.threadId);
    const existing = this.stateStore.binding(thread.id);
    this.stateStore.setBinding(thread.id, {
      channelId: channel.id,
      categoryId,
      projectKey,
      projectId,
      archived,
      hidden: false,
      name: thread.name ?? thread.preview ?? null,
      taskStatus: thread.status?.type ?? 'unknown',
      cwd: thread.cwd ?? null,
      sessionPath: thread.path ?? existing?.sessionPath ?? null,
      watchLevel: existing?.watchLevel ?? this.config.defaultWatchLevel,
      completionReportsEnabled: existing?.completionReportsEnabled ?? true,
      lastCompletedTurnId: existing?.lastCompletedTurnId ?? null,
      snapshotInitialized: existing?.snapshotInitialized ?? false,
    });
    if (subscribe) await this.codex.resumeThread(thread.id);
  }

  async #fetchChannelHistory(channel, maximum = 1000) {
    const messages = new Map();
    let before;
    while (messages.size < maximum) {
      const page = await channel.messages.fetch({ limit: Math.min(100, maximum - messages.size), before });
      if (page.size === 0) break;
      for (const message of page.values()) messages.set(message.id, message);
      before = page.last()?.id;
      if (page.size < 100) break;
    }
    return messages;
  }

  async #resolveChannelMessage(channel, messages, messageId) {
    if (!messageId) return null;
    const cached = messages.get(messageId);
    if (cached) return cached;
    const fetched = await channel.messages.fetch(messageId).catch(() => null);
    if (fetched) messages.set(fetched.id, fetched);
    return fetched;
  }

  #turnUserItems(turn) {
    return (turn.items ?? [])
      .filter((item) => item.type === 'userMessage')
      .map((item, index) => ({
        id: item.id ?? `user-${index + 1}`,
        text: (item.content ?? []).map((part) => part.text ?? '').filter(Boolean).join('\n'),
      }))
      .filter((item) => item.text);
  }

  #turnMessageHeader(kind, threadId, turnId, part, total, status = null, itemId = null) {
    const title = kind === 'user'
      ? '**User instruction**'
      : `**Codex turn ${status === 'completed' ? 'completed' : status}**`;
    return [
      title,
      `Task ID: \`${threadId}\``,
      `Turn ID: \`${turnId}\``,
      ...(itemId ? [`Item ID: \`${itemId}\``] : []),
      `Message: ${kind}`,
      `Part: ${part}/${total}`,
    ].join('\n');
  }

  #turnMessagePlan(kind, threadId, turn, text, itemId = null) {
    const plan = planDiscordTextDelivery(text || '(textなし)', 5, 1500);
    const chunks = plan.attachmentText
      ? ['全内容を添付しました。直近部分を続けて表示します。', ...plan.messages]
      : plan.messages;
    return chunks.map((chunk, index) => ({
      content: `${this.#turnMessageHeader(kind, threadId, turn.id, index + 1, chunks.length, turn.status, itemId)}\n\n${chunk}`,
      attachmentText: index === 0 ? plan.attachmentText : null,
    }));
  }

  #normalizedTurnMessage(message, threadId, turnId, kind, part, itemId = null) {
    return message.content.includes(`Task ID: \`${threadId}\``)
      && message.content.includes(`Turn ID: \`${turnId}\``)
      && (!itemId || message.content.includes(`Item ID: \`${itemId}\``))
      && message.content.includes(`Message: ${kind}`)
      && message.content.includes(`Part: ${part}/`);
  }

  #turnMessageMatches(message, options, expectsAttachment) {
    return message.content === options.content
      && message.embeds.length === 0
      && (expectsAttachment ? message.attachments.size > 0 : message.attachments.size === 0);
  }

  #cardMessageMatches(message, options, expectedAttachments) {
    const normalizeEmbed = (embed) => {
      const value = typeof embed?.toJSON === 'function' ? embed.toJSON() : embed ? { ...embed } : null;
      if (!value) return value;
      delete value.type;
      delete value.content_scan_version;
      value.fields = value.fields?.map((field) => {
        if (field.inline !== false) return field;
        const normalized = { ...field };
        delete normalized.inline;
        return normalized;
      });
      return value;
    };
    const actualEmbed = normalizeEmbed(message.embeds[0]);
    const expectedEmbed = normalizeEmbed(options.embeds[0]);
    const componentData = (component) => (typeof component?.toJSON === 'function' ? component.toJSON() : component);
    const attachmentsMatch = Array.isArray(expectedAttachments)
      ? isDeepStrictEqual(
        [...message.attachments.values()].map((attachment) => attachment.name).sort(),
        [...expectedAttachments].sort(),
      )
      : (expectedAttachments ? message.attachments.size > 0 : message.attachments.size === 0);
    return message.content === (options.content ?? '')
      && message.embeds.length === 1
      && isDeepStrictEqual(actualEmbed, expectedEmbed)
      && isDeepStrictEqual(
        (message.components ?? []).map(componentData),
        (options.components ?? []).map(componentData),
      )
      && attachmentsMatch;
  }

  #embedTurnId(message) {
    for (const embed of message.embeds) {
      const footerMatch = embed.footer?.text?.match(/^turn (.+)$/);
      if (footerMatch) return footerMatch[1];
      const field = embed.fields?.find((candidate) => candidate.name === 'Turn');
      const fieldMatch = field?.value?.match(/`([^`]+)`/);
      if (fieldMatch) return fieldMatch[1];
    }
    return null;
  }

  #embedTaskId(message) {
    for (const embed of message.embeds) {
      const field = embed.fields?.find((candidate) => candidate.name === 'Task');
      const match = field?.value?.match(/`([^`]+)`/);
      if (match) return match[1];
    }
    return null;
  }

  #embedUserMessageId(message) {
    for (const embed of message.embeds) {
      if (embed.title !== 'User message') continue;
      const field = embed.fields?.find((candidate) => candidate.name === 'Message');
      const match = field?.value?.match(/`([^`]+)`/);
      if (match) return match[1];
    }
    return null;
  }

  #embedAssistantMessageId(message) {
    for (const embed of message.embeds) {
      if (!['Codex message', 'Codex reasoning summary', 'Codex running'].includes(embed.title)) continue;
      const field = embed.fields?.find((candidate) => candidate.name === 'Message');
      const match = field?.value?.match(/`([^`]+)`/);
      if (match) return match[1];
    }
    return null;
  }

  #embedContextCompactionItemId(message) {
    for (const embed of message.embeds) {
      if (embed.title !== 'Codex context compacted') continue;
      const field = embed.fields?.find((candidate) => candidate.name === 'Item');
      const match = field?.value?.match(/`([^`]+)`/);
      if (match) return match[1];
    }
    return null;
  }

  #embedCodexImageItemId(message) {
    for (const embed of message.embeds) {
      if (embed.title !== 'Codex image') continue;
      const field = embed.fields?.find((candidate) => candidate.name === 'Item');
      const match = field?.value?.match(/`([^`]+)`/);
      if (match) return match[1];
    }
    return null;
  }

  #isAssistantTurnCard(message, turnId) {
    return message.author.id === this.client.user.id
      && this.#embedTurnId(message) === turnId
      && message.embeds.some((embed) => /^Codex (?:running|turn )/.test(embed.title ?? ''));
  }

  async #assistantMessageCardOptions(binding, turn, item, existingMessage = null) {
    const value = String(item.text ?? '').trim() || '(empty)';
    const localFiles = extractLocalFileReferences(value);
    const embed = new EmbedBuilder()
      .setTitle(item.phase === 'reasoning' ? 'Codex reasoning summary' : 'Codex message')
      .setColor(item.phase === 'reasoning' ? COLORS.warning : COLORS.neutral)
      .setDescription(truncate(value, 3900))
      .addFields(
        { name: 'Task', value: `\`${binding.threadId}\`` },
        { name: 'Turn', value: `\`${turn.id}\`` },
        { name: 'Message', value: `\`${item.id}\`` },
      );
    const fullTextName = `codex-turn-${turn.id}-${item.id}-assistant.txt`;
    const matchingAttachment = value.length > 3900
      ? [...(existingMessage?.attachments.values() ?? [])]
        .find((attachment) => attachment.name === fullTextName)
      : null;
    const inlineImages = await this.#inlineImageCardAttachments(
      binding,
      localFiles,
      existingMessage,
      value.length > 3900 ? [fullTextName] : [],
    );
    const options = {
      content: '',
      embeds: [embed],
      components: contentCardComponents(localFiles.length),
      attachments: [
        ...(matchingAttachment ? [{ id: matchingAttachment.id }] : []),
        ...inlineImages.attachments,
      ],
      allowedMentions: { parse: [] },
    };
    const files = [
      ...(value.length > 3900 && !matchingAttachment ? [this.#textAttachment(value, fullTextName)] : []),
      ...inlineImages.files,
    ];
    if (files.length) options.files = files;
    return {
      options,
      expectedAttachmentNames: [
        ...(value.length > 3900 ? [fullTextName] : []),
        ...inlineImages.names,
      ],
      localFiles,
    };
  }

  async #ensureAssistantMessageCard(
    binding,
    turn,
    item,
    channel,
    messages,
    preferredMessageId = null,
    { migrationEntryId = null, excludedMessageIds = new Set() } = {},
  ) {
    const record = this.stateStore.turnRecord(binding.threadId, turn.id) ?? {};
    const assistantEntries = { ...(record.assistantEntries ?? {}) };
    const existingIds = assistantEntries[item.id]?.messageIds
      ?? (migrationEntryId ? assistantEntries[migrationEntryId]?.messageIds : null)
      ?? [];
    let message = await this.#resolveChannelMessage(channel, messages, preferredMessageId ?? existingIds[0]);
    if (excludedMessageIds.has(message?.id)) message = null;
    if (!migrationEntryId && message && this.#embedAssistantMessageId(message)
      && this.#embedAssistantMessageId(message) !== item.id) {
      message = null;
    }
    if (!message) {
      message = [...messages.values()].find((candidate) => candidate.author.id === this.client.user.id
        && !excludedMessageIds.has(candidate.id)
        && this.#embedTurnId(candidate) === turn.id
        && this.#embedAssistantMessageId(candidate) === item.id);
    }
    const duplicateIds = [...messages.values()]
      .filter((candidate) => candidate.author.id === this.client.user.id
        && this.#embedTurnId(candidate) === turn.id
        && this.#embedAssistantMessageId(candidate) === item.id)
      .map((candidate) => candidate.id);
    const card = await this.#assistantMessageCardOptions(binding, turn, item, message);
    if (message?.author.id === this.client.user.id) {
      if (!this.#cardMessageMatches(message, card.options, card.expectedAttachmentNames)) {
        message = await message.edit(card.options);
      }
    } else {
      message = await channel.send(card.options);
    }
    messages.set(message.id, message);

    const staleIds = new Set([...existingIds, ...duplicateIds].filter(Boolean));
    staleIds.delete(message.id);
    if (migrationEntryId && migrationEntryId !== item.id) delete assistantEntries[migrationEntryId];
    const claimedByOtherEntries = new Set(Object.entries(assistantEntries)
      .filter(([entryId]) => entryId !== item.id)
      .flatMap(([, entry]) => entry.messageIds ?? []));
    for (const staleId of staleIds) {
      if (claimedByOtherEntries.has(staleId)) continue;
      const stale = await this.#resolveChannelMessage(channel, messages, staleId);
      if (stale?.author.id === this.client.user.id) {
        await stale.delete().catch((error) => {
          if (error.code !== 10008) throw error;
        });
      }
      messages.delete(staleId);
    }

    assistantEntries[item.id] = {
      text: item.text,
      phase: item.phase,
      messageIds: [message.id],
      localFiles: card.localFiles,
    };
    const patch = {
      assistantEntries,
      assistantMessageIds: [...new Set(Object.values(assistantEntries).flatMap((entry) => entry.messageIds ?? []))],
    };
    if (record.cardMessageId === message.id || record.liveMessageId === message.id) {
      patch.cardMessageId = null;
      patch.liveMessageId = null;
    }
    this.stateStore.setTurnRecord(binding.threadId, turn.id, patch);
    return message;
  }

  async #ensureCodexImageCard(binding, turn, item, channel, messages) {
    if (!item?.id || !hasCodexImageContent(item)) return { message: null, created: false };
    const record = this.stateStore.turnRecord(binding.threadId, turn.id) ?? {};
    const imageEntries = { ...(record.imageEntries ?? {}) };
    const recorded = imageEntries[item.id] ?? null;
    let message = await this.#resolveChannelMessage(channel, messages, recorded?.messageId);
    if (!message) {
      message = [...messages.values()].find((candidate) => candidate.author.id === this.client.user.id
        && this.#embedTurnId(candidate) === turn.id
        && this.#embedCodexImageItemId(candidate) === item.id) ?? null;
    }
    const duplicateIds = [...messages.values()]
      .filter((candidate) => candidate.author.id === this.client.user.id
        && this.#embedTurnId(candidate) === turn.id
        && this.#embedCodexImageItemId(candidate) === item.id)
      .map((candidate) => candidate.id);
    const imageAttachments = await this.#codexImageCardAttachments(binding, item, message);
    if (imageAttachments.names.length === 0) {
      // A hydrated item can occasionally omit an older binary result. Never
      // delete the Discord copy when the durable message still exists.
      return { message, created: false };
    }

    const embed = new EmbedBuilder()
      .setTitle('Codex image')
      .setColor(COLORS.neutral)
      .setDescription(imageAttachments.names.length === 1
        ? 'Codex画面に表示された画像です。'
        : `Codex画面に表示された画像 ${imageAttachments.names.length} 件です。`)
      .addFields(
        { name: 'Task', value: `\`${binding.threadId}\`` },
        { name: 'Turn', value: `\`${turn.id}\`` },
        { name: 'Item', value: `\`${item.id}\`` },
      );
    const options = {
      content: '',
      embeds: [embed],
      attachments: imageAttachments.attachments,
      allowedMentions: { parse: [] },
    };
    if (imageAttachments.files.length) options.files = imageAttachments.files;
    let created = false;
    if (message?.author.id === this.client.user.id) {
      if (!this.#cardMessageMatches(message, options, imageAttachments.names)) {
        message = await message.edit(options);
      }
    } else {
      message = await channel.send(options);
      created = true;
    }
    messages.set(message.id, message);

    const staleIds = new Set([recorded?.messageId, ...duplicateIds].filter(Boolean));
    staleIds.delete(message.id);
    for (const staleId of staleIds) {
      const stale = await this.#resolveChannelMessage(channel, messages, staleId);
      if (stale?.author.id === this.client.user.id) {
        await stale.delete().catch((error) => {
          if (error.code !== 10008) throw error;
        });
      }
      messages.delete(staleId);
    }

    imageEntries[item.id] = {
      messageId: message.id,
      attachments: imageAttachments.metadata,
      completedAt: recorded?.completedAt ?? new Date().toISOString(),
    };
    this.stateStore.setTurnRecord(binding.threadId, turn.id, {
      imageEntries,
      imageMessageIds: [...new Set(Object.values(imageEntries)
        .map((entry) => entry.messageId)
        .filter(Boolean))],
    });
    return { message, created };
  }

  async #reconcileCodexImageItems(binding, turn, channel, messages, { onlyRecorded = false } = {}) {
    const record = this.stateStore.turnRecord(binding.threadId, turn.id) ?? {};
    const recordedIds = new Set(Object.keys(record.imageEntries ?? {}));
    const results = [];
    for (const item of turn.items ?? []) {
      if (!hasCodexImageContent(item) || (onlyRecorded && !recordedIds.has(item.id))) continue;
      results.push(await this.#ensureCodexImageCard(binding, turn, item, channel, messages));
    }
    return results;
  }

  async #reconcileStableAssistantMessages(binding, turn, channel, messages) {
    const stableItems = (turn.items ?? [])
      .filter((item) => item.type === 'agentMessage' && item.phase === 'commentary' && item.text);
    const migratedEntryIds = new Set();
    const usedMessageIds = new Set();
    for (const item of stableItems) {
      const record = this.stateStore.turnRecord(binding.threadId, turn.id) ?? {};
      const entries = record.assistantEntries ?? {};
      const migrationEntryId = entries[item.id] ? null : Object.entries(entries)
        .find(([entryId, entry]) => !migratedEntryIds.has(entryId)
          && entry.phase === item.phase
          && entry.text?.trim() === item.text.trim())?.[0] ?? null;
      if (migrationEntryId) migratedEntryIds.add(migrationEntryId);
      const preferredMessageId = entries[item.id]?.messageIds?.[0]
        ?? (migrationEntryId ? entries[migrationEntryId]?.messageIds?.[0] : null)
        ?? null;
      const message = await this.#ensureAssistantMessageCard(
        binding,
        turn,
        item,
        channel,
        messages,
        preferredMessageId,
        { migrationEntryId, excludedMessageIds: usedMessageIds },
      );
      usedMessageIds.add(message.id);
    }
    await this.#pruneSupersededAssistantEntries(binding, turn, channel, messages);
  }

  async #pruneSupersededAssistantEntries(
    binding,
    turn,
    channel,
    messages,
    { requireStableCoverage = false } = {},
  ) {
    if (turn.status === 'inProgress') return 0;
    const stableItems = (turn.items ?? [])
      .filter((item) => item.type === 'agentMessage' && item.phase === 'commentary' && item.text);
    if (stableItems.length === 0) return 0;
    const stableIds = new Set(stableItems.map((item) => item.id));
    const record = this.stateStore.turnRecord(binding.threadId, turn.id) ?? {};
    const assistantEntries = { ...(record.assistantEntries ?? {}) };
    if (requireStableCoverage && stableItems.some((item) => !(assistantEntries[item.id]?.messageIds ?? [])
      .some((messageId) => messages.has(messageId)))) return 0;

    const supersededEntryIds = Object.keys(assistantEntries)
      .filter((entryId) => !stableIds.has(entryId));
    if (supersededEntryIds.length === 0) return 0;
    const stableMessageIds = new Set(stableItems
      .flatMap((item) => assistantEntries[item.id]?.messageIds ?? []));
    const deletedMessageIds = new Set();
    for (const entryId of supersededEntryIds) {
      for (const messageId of assistantEntries[entryId]?.messageIds ?? []) {
        if (stableMessageIds.has(messageId)) continue;
        const message = await this.#resolveChannelMessage(channel, messages, messageId);
        const isOwnedTurnCard = message?.author.id === this.client.user.id
          && this.#embedTaskId(message) === binding.threadId
          && this.#embedTurnId(message) === turn.id
          && message.embeds.some((embed) => ['Codex message', 'Codex running'].includes(embed.title));
        if (isOwnedTurnCard) {
          await message.delete().catch((error) => {
            if (error.code !== 10008) throw error;
          });
          messages.delete(messageId);
          deletedMessageIds.add(messageId);
        }
      }
      delete assistantEntries[entryId];
    }
    this.stateStore.setTurnRecord(binding.threadId, turn.id, {
      assistantEntries,
      assistantMessageIds: [...new Set(Object.values(assistantEntries)
        .flatMap((entry) => entry.messageIds ?? []))],
      ...(deletedMessageIds.has(record.cardMessageId) ? { cardMessageId: null } : {}),
      ...(deletedMessageIds.has(record.liveMessageId) ? { liveMessageId: null } : {}),
    });
    this.#log('superseded-assistant-entries-pruned', {
      threadId: binding.threadId,
      turnId: turn.id,
      entryCount: supersededEntryIds.length,
      messageCount: deletedMessageIds.size,
    });
    return supersededEntryIds.length;
  }

  #userCardOptions(binding, turn, userItem, sourceMessage = null, existingMessage = null) {
    const value = String(userItem.text ?? '').trim() || '(empty)';
    const embed = new EmbedBuilder()
      .setTitle('User message')
      .setColor(COLORS.user)
      .setDescription(truncate(value, 3900))
      .addFields(
        { name: 'Task', value: `\`${binding.threadId}\`` },
        { name: 'Turn', value: `\`${turn.id}\`` },
        { name: 'Message', value: `\`${userItem.id}\`` },
      );
    const options = {
      content: '',
      embeds: [embed],
      components: contentCardComponents(),
      attachments: [],
      allowedMentions: { parse: [] },
    };
    const files = [];
    const existingAttachments = [...(existingMessage?.attachments.values() ?? [])];
    const fullTextName = `codex-turn-${turn.id}-${userItem.id}-user.txt`;
    if (value.length > 3900 && !existingAttachments.some((attachment) => attachment.name === fullTextName)) {
      files.push(this.#textAttachment(value, fullTextName));
    }
    if (sourceMessage && sourceMessage.author.id !== this.client.user.id) {
      for (const attachment of sourceMessage.attachments.values()) {
        if (!existingAttachments.some((existing) => existing.name === attachment.name)) {
          files.push({ attachment: attachment.url, name: attachment.name });
        }
      }
    }
    options.attachments = existingAttachments.map((attachment) => ({ id: attachment.id }));
    if (files.length) options.files = files;
    return { options, expectsAttachment: files.length > 0 || existingAttachments.length > 0 };
  }

  async #ensureTurnUserMessages(binding, turn, channel, messages, requestedItemIds = null) {
    const requested = requestedItemIds ? new Set(requestedItemIds) : null;
    const userItems = this.#turnUserItems(turn)
      .filter((item) => !requested || requested.has(item.id));
    const allIds = [];
    const latestBinding = this.stateStore.binding(binding.threadId) ?? binding;
    const globallyClaimedIds = new Set(Object.entries(latestBinding.turnMessages ?? {})
      .filter(([turnId]) => turnId !== turn.id)
      .flatMap(([, record]) => record.userMessageIds ?? []));
    for (const userItem of userItems) {
      const record = this.stateStore.turnRecord(binding.threadId, turn.id) ?? {};
      const userEntries = { ...(record.userEntries ?? {}) };
      const existingIds = userEntries[userItem.id]?.messageIds ?? [];
      const claimedIds = new Set(Object.values(userEntries).flatMap((entry) => entry.messageIds ?? []));
      let message = await this.#resolveChannelMessage(channel, messages, existingIds[0]);
      let sourceMessage = null;
      let migratedEntryId = null;
      if (message && this.#hasMessageExecutionPermission(message)) {
        sourceMessage = message;
        message = null;
      }

      if (!message) {
        message = [...messages.values()].find((candidate) => candidate.author.id === this.client.user.id
          && !globallyClaimedIds.has(candidate.id)
          && this.#embedTurnId(candidate) === turn.id
          && this.#embedUserMessageId(candidate) === userItem.id);
      }

      for (const [entryId, entry] of Object.entries(userEntries)) {
        if (message || sourceMessage || entryId === userItem.id || allIds.includes(entry.messageIds?.[0])) continue;
        const candidate = await this.#resolveChannelMessage(channel, messages, entry.messageIds?.[0]);
        const sameText = entry.text?.trim() === userItem.text.trim()
          || userItem.text.trim().startsWith(entry.text?.trim() ?? '\0');
        if (!candidate || !sameText) continue;
        migratedEntryId = entryId;
        if (candidate.author.id === this.client.user.id) message = candidate;
        else if (this.#hasMessageExecutionPermission(candidate)) sourceMessage = candidate;
      }

      if (!message) {
        message = [...messages.values()].find((candidate) => candidate.author.id === this.client.user.id
          && !globallyClaimedIds.has(candidate.id)
          && this.#normalizedTurnMessage(candidate, binding.threadId, turn.id, 'user', 1, userItem.id));
      }
      if (!message) {
        message = [...messages.values()].find((candidate) => candidate.author.id === this.client.user.id
          && !claimedIds.has(candidate.id)
          && candidate.embeds.some((embed) => embed.title === 'User instruction'
            && embed.description?.trim() === userItem.text.trim()));
      }

      if (!sourceMessage) {
        sourceMessage = [...messages.values()]
          .filter((candidate) => this.#hasMessageExecutionPermission(candidate)
            && !claimedIds.has(candidate.id)
            && !globallyClaimedIds.has(candidate.id)
            && !allIds.includes(candidate.id))
          .find((candidate) => candidate.content.trim() === userItem.text.trim());
      }

      const card = this.#userCardOptions(binding, turn, userItem, sourceMessage, message);
      const duplicateCardIds = [...messages.values()]
        .filter((candidate) => candidate.author.id === this.client.user.id
          && this.#embedTurnId(candidate) === turn.id
          && this.#embedUserMessageId(candidate) === userItem.id)
        .map((candidate) => candidate.id);
      if (message?.author.id === this.client.user.id) {
        if (!this.#cardMessageMatches(message, card.options, card.expectsAttachment)) {
          message = await message.edit(card.options);
        }
      } else {
        message = await channel.send(card.options);
      }
      messages.set(message.id, message);

      const staleIds = new Set([
        ...existingIds,
        ...(migratedEntryId ? userEntries[migratedEntryId]?.messageIds ?? [] : []),
        ...duplicateCardIds,
        sourceMessage?.id,
      ].filter(Boolean));
      staleIds.delete(message.id);
      for (const staleId of staleIds) {
        const stale = await this.#resolveChannelMessage(channel, messages, staleId);
        if (stale && (stale.author.id === this.client.user.id || this.#hasMessageExecutionPermission(stale))) {
          await stale.delete().catch((error) => {
            if (error.code !== 10008) throw error;
          });
        }
        messages.delete(staleId);
      }

      const source = userEntries[userItem.id]?.source
        ?? (migratedEntryId ? userEntries[migratedEntryId]?.source : null)
        ?? emptyDuplicateUserEntryIds(userEntries, userItem)
          .map((entryId) => userEntries[entryId]?.source)
          .find(Boolean)
        ?? null;
      if (migratedEntryId) delete userEntries[migratedEntryId];
      for (const entryId of emptyDuplicateUserEntryIds(userEntries, userItem)) {
        delete userEntries[entryId];
      }
      userEntries[userItem.id] = {
        text: userItem.text,
        messageIds: [message.id],
        source,
      };
      allIds.push(message.id);
      this.stateStore.setTurnRecord(binding.threadId, turn.id, {
        userEntries,
        userMessageIds: [...new Set(Object.values(userEntries).flatMap((entry) => entry.messageIds ?? []))],
      });
    }
    return allIds;
  }

  async #ensureTurnFinalMessages(binding, turn, finalText, channel, messages, liveMessageId = null) {
    const record = this.stateStore.turnRecord(binding.threadId, turn.id) ?? {};
    let message = await this.#resolveChannelMessage(channel, messages, record.finalMessageIds?.[0]);
    if (message && !message.embeds.some((embed) => /^Codex turn /.test(embed.title ?? ''))) {
      message = null;
    }
    if (!message) {
      message = [...messages.values()].find((candidate) => candidate.author.id === this.client.user.id
        && this.#embedTurnId(candidate) === turn.id
        && candidate.embeds.some((embed) => /^Codex turn /.test(embed.title ?? '')));
    }
    if (!message) {
      message = [...messages.values()].find((candidate) => this.#normalizedTurnMessage(
        candidate,
        binding.threadId,
        turn.id,
        'final',
        1,
      ));
    }

    const value = String(finalText || turn.error?.message || 'このターンにはassistantメッセージが記録されていません。');
    const localFiles = extractLocalFileReferences(value);
    const embed = new EmbedBuilder()
      .setTitle(`Codex turn ${turn.status === 'completed' ? 'completed' : turn.status}`)
      .setColor(turn.status === 'completed' ? COLORS.completed : COLORS.error)
      .setDescription(truncate(value, 3900))
      .addFields(
        { name: 'Task', value: `\`${binding.threadId}\`` },
        { name: 'Turn', value: `\`${turn.id}\`` },
      );
    const fullTextName = `codex-turn-${turn.id}-final.txt`;
    const matchingAttachment = value.length > 3900
      ? [...(message?.attachments.values() ?? [])]
        .find((attachment) => attachment.name === fullTextName)
      : null;
    const inlineImages = await this.#inlineImageCardAttachments(
      binding,
      localFiles,
      message,
      value.length > 3900 ? [fullTextName] : [],
    );
    const options = {
      content: '',
      embeds: [embed],
      components: contentCardComponents(localFiles.length),
      attachments: [
        ...(matchingAttachment ? [{ id: matchingAttachment.id }] : []),
        ...inlineImages.attachments,
      ],
      allowedMentions: { parse: [] },
    };
    const attachmentText = value.length > 3900 ? value : null;
    const files = [
      ...(attachmentText && !matchingAttachment ? [this.#textAttachment(attachmentText, fullTextName)] : []),
      ...inlineImages.files,
    ];
    if (files.length) options.files = files;
    const expectedAttachmentNames = [
      ...(attachmentText ? [fullTextName] : []),
      ...inlineImages.names,
    ];
    const duplicateCardIds = [...messages.values()]
      .filter((candidate) => this.#isAssistantTurnCard(candidate, turn.id))
      .map((candidate) => candidate.id);
    if (message?.author.id === this.client.user.id) {
      if (!this.#cardMessageMatches(message, options, expectedAttachmentNames)) {
        message = await message.edit(options);
      }
    } else message = await channel.send(options);
    messages.set(message.id, message);

    const staleIds = new Set([
      ...(record.finalMessageIds ?? []),
      record.cardMessageId,
      record.liveMessageId,
      liveMessageId,
      ...duplicateCardIds,
    ].filter(Boolean));
    staleIds.delete(message.id);
    for (const staleId of staleIds) {
      const stale = await this.#resolveChannelMessage(channel, messages, staleId);
      if (stale?.author.id === this.client.user.id) {
        await stale.delete().catch((error) => {
          if (error.code !== 10008) throw error;
        });
      }
      messages.delete(staleId);
    }
    this.stateStore.setTurnRecord(binding.threadId, turn.id, {
      liveMessageId: null,
      cardMessageId: message.id,
      finalMessageIds: [message.id],
      finalText: value,
      finalLocalFiles: localFiles,
      status: turn.status,
      finalizedAt: new Date().toISOString(),
    });
    return message;
  }

  async #ensureLiveTurnCard(binding, turn, view, channel, messages) {
    if (!this.#isCurrentLiveTurnView(view)) return null;
    const record = this.stateStore.turnRecord(binding.threadId, turn.id) ?? {};
    const assistantEntryId = view.currentPhase === 'commentary' ? view.currentMessageId : null;
    const assistantEntryMessageId = assistantEntryId
      ? record.assistantEntries?.[assistantEntryId]?.messageIds?.[0]
      : null;
    let message = await this.#resolveChannelMessage(
      channel,
      messages,
      record.cardMessageId ?? record.liveMessageId ?? assistantEntryMessageId,
    );
    if (!message) {
      message = [...messages.values()].find((candidate) => candidate.author.id === this.client.user.id
        && this.#embedTurnId(candidate) === turn.id
        && candidate.embeds.some((embed) => embed.title === 'Codex running')
        && (!view.currentMessageId || this.#embedAssistantMessageId(candidate) === view.currentMessageId));
    }
    if (!this.#isCurrentLiveTurnView(view)) return null;
    const localFiles = extractLocalFileReferences(view.text);
    const components = contentCardComponents(localFiles.length);
    if (message) {
      await message.edit({ content: '', embeds: [this.#turnEmbed(view)], components, attachments: [], allowedMentions: { parse: [] } });
    } else {
      message = await channel.send({ embeds: [this.#turnEmbed(view)], components, allowedMentions: { parse: [] } });
    }
    messages.set(message.id, message);
    await this.#deleteDuplicateLiveTurnCards(binding, turn.id, messages, message.id);
    view.messageId = message.id;
    view.message = message;
    const latestRecord = this.stateStore.turnRecord(binding.threadId, turn.id) ?? record;
    const patch = {
      cardMessageId: message.id,
      liveMessageId: message.id,
      status: 'inProgress',
      startedAt: view.startedAt,
    };
    if (assistantEntryId) {
      const assistantEntries = { ...(latestRecord.assistantEntries ?? {}) };
      assistantEntries[assistantEntryId] = {
        text: view.text,
        phase: view.currentPhase,
        messageIds: [message.id],
        localFiles,
      };
      patch.assistantEntries = assistantEntries;
      patch.assistantMessageIds = [...new Set(Object.values(assistantEntries)
        .flatMap((entry) => entry.messageIds ?? []))];
    }
    this.stateStore.setTurnRecord(binding.threadId, turn.id, patch);
    return message;
  }

  async #cleanupLegacyTranscriptMessages(channel, messages, protectedIds) {
    for (const message of [...messages.values()]) {
      if (message.author.id !== this.client.user.id || protectedIds.has(message.id)) continue;
      if (this.#panelMarker(message)?.startsWith('Codex Remote UI /')) continue;
      const legacyEmbed = message.embeds.some((embed) => {
        const fieldNames = new Set(embed.fields?.map((field) => field.name) ?? []);
        const hasCurrentIdentity = fieldNames.has('Task') && fieldNames.has('Turn');
        return !hasCurrentIdentity && ([
          'User instruction', 'Codex running', 'Codex completed', 'Codex turn completed',
        ].includes(embed.title) || fieldNames.has('Task ID'));
      });
      const legacySnapshot = message.content.startsWith('```text\n')
        || message.content.startsWith('**切断中に完了したターンを再同期しました**')
        || [...message.attachments.values()].some((attachment) => /codex-(?:catchup|thread-snapshot)-full\.txt/i.test(attachment.name));
      const unclaimedTranscript = message.content.includes('Task ID: `')
        && message.content.includes('Turn ID: `')
        && /Message: (?:user|final)/.test(message.content);
      const staleUserCard = message.embeds.some((embed) => embed.title === 'User message');
      const staleUnidentifiedLiveCard = message.embeds.some((embed) => embed.title === 'Codex running'
        && !embed.fields?.some((field) => field.name === 'Message'));
      if (!legacyEmbed && !legacySnapshot && !unclaimedTranscript && !staleUserCard && !staleUnidentifiedLiveCard) continue;
      await message.delete().catch(() => {});
      messages.delete(message.id);
    }
  }

  async #cleanupInheritedSubagentMessages(binding, channel, messages, ownTurnIds) {
    const stale = [];
    for (const message of [...messages.values()]) {
      if (message.author.id !== this.client.user.id) continue;
      if (this.#embedTaskId(message) !== binding.threadId) continue;
      const turnId = this.#embedTurnId(message);
      if (!turnId || ownTurnIds.has(turnId)) continue;
      stale.push(message);
    }
    if (stale.length > 1 && typeof channel.bulkDelete === 'function') {
      for (let index = 0; index < stale.length; index += 100) {
        const batch = stale.slice(index, index + 100);
        const deleted = await channel.bulkDelete(
          batch.map((message) => message.id),
          true,
          `Remove inherited Codex turns from subagent ${binding.threadId}`,
        );
        for (const id of deleted.keys()) messages.delete(id);
      }
    }
    for (const message of stale) {
      if (!messages.has(message.id)) continue;
      await message.delete().catch((error) => {
        if (error.code !== 10008) throw error;
      });
      messages.delete(message.id);
    }
  }

  async #reconcileThreadTranscript(threadId, options = {}) {
    if (this.transcriptSyncPromises.has(threadId)) {
      const existing = this.transcriptSyncPromises.get(threadId);
      if (options.recentSinceMs === null || options.recentSinceMs === undefined) return existing;
      // A bounded user-requested restore must not be absorbed by a reconnect
      // or live active-only reconciliation that happens to be in flight.
      await existing.catch(() => {});
      return this.#reconcileThreadTranscript(threadId, options);
    }
    const run = async () => {
      this.#log('transcript-sync-start', {
        threadId,
        activeOnly: Boolean(options.activeOnly),
        boundedHistory: Number.isFinite(options.recentSinceMs),
      });
      try {
        const result = await this.#performTranscriptReconciliation(threadId, options);
        this.#log('transcript-sync-completed', {
          threadId,
          activeOnly: Boolean(options.activeOnly),
          boundedHistory: Number.isFinite(options.recentSinceMs),
        });
        return result;
      } catch (error) {
        this.#log('transcript-sync-failed', { threadId, error: error.stack ?? error.message });
        throw error;
      }
    };
    const promise = this.transcriptSyncTail.then(run, run);
    this.transcriptSyncTail = promise.catch(() => {});
    this.transcriptSyncPromises.set(threadId, promise);
    try {
      return await promise;
    } finally {
      this.transcriptSyncPromises.delete(threadId);
    }
  }

  async #performTranscriptReconciliation(threadId, {
    channel: knownChannel = null,
    activeOnly = false,
    recentSinceMs = null,
    includeHistoricalDetails = false,
  } = {}) {
    if (this.stopping) throw new Error('Transcript reconciliation stopped during Bridge shutdown.');
    const binding = this.stateStore.binding(threadId);
    if (!binding) throw new Error(`Task is not bound: ${threadId}`);
    const channel = knownChannel ?? await this.client.channels.fetch(binding.channelId);
    // thread/list entries can omit historical turns and items. Reconciliation
    // must only prune Discord messages against a fully hydrated transcript.
    const hydratedThread = (await this.codex.readThread(threadId)).thread;
    const thread = binding.isSubagent
      ? { ...hydratedThread, turns: subagentOwnTurns(hydratedThread) }
      : hydratedThread;
    const ownTurnIds = new Set((thread.turns ?? []).map((turn) => turn.id));
    if (binding.isSubagent && typeof this.stateStore.retainSubagentTurnRecords === 'function') {
      this.stateStore.retainSubagentTurnRecords(threadId, ownTurnIds);
    }
    const messages = await this.#fetchChannelHistory(channel);
    const sessionOrderRepairTurnIds = recentSinceMs === null
      ? Object.entries(binding.turnMessages ?? {})
        .filter(([, record]) => record?.sessionOrderRepairRequestedAt)
        .map(([turnId]) => turnId)
      : [];
    const sessionOrderRepairIds = sessionOrderRepairMessageIds(
      messages,
      sessionOrderRepairTurnIds,
      this.client.user.id,
    );
    for (const messageId of sessionOrderRepairIds) {
      const message = messages.get(messageId);
      await message?.delete().catch((error) => {
        if (error.code !== 10008) throw error;
      });
      messages.delete(messageId);
    }
    if (sessionOrderRepairIds.length) {
      this.#log('session-order-repair-cleared-cards', {
        threadId,
        turnIds: sessionOrderRepairTurnIds,
        messageCount: sessionOrderRepairIds.length,
      });
    }
    if (binding.isSubagent) {
      await this.#cleanupInheritedSubagentMessages(binding, channel, messages, ownTurnIds);
    }
    const completedTurns = recentSinceMs === null
      ? (thread.turns ?? []).filter((turn) => turn.status !== 'inProgress')
      : completedTurnsSince(thread.turns, recentSinceMs);
    const rawActiveTurn = [...(thread.turns ?? [])].reverse().find((turn) => turn.status === 'inProgress') ?? null;
    const rawActiveRecord = rawActiveTurn
      ? this.stateStore.turnRecord(threadId, rawActiveTurn.id) ?? {}
      : {};
    const finalizedActiveSnapshot = Boolean(
      rawActiveRecord.finalizedAt
      && rawActiveRecord.status !== 'inProgress'
      && rawActiveRecord.finalMessageIds?.length,
    );
    // The current active turn remains represented by its single live card.
    // A bounded historical restore only adds completed-turn cards.
    // A stale thread/read response must not recreate a live card after the
    // corresponding turn/completed notification has already been finalized.
    const activeTurn = recentSinceMs === null && !finalizedActiveSnapshot ? rawActiveTurn : null;
    const turnsById = new Map((thread.turns ?? []).map((turn) => [turn.id, turn]));
    const commentaryByKey = new Map();
    for (const turn of thread.turns ?? []) {
      for (const item of turn.items ?? []) {
        if (item.type === 'agentMessage' && item.phase === 'commentary' && item.text) {
          commentaryByKey.set(`${turn.id}:${item.id}`, { turn, item });
        }
      }
    }
    const requiredCommentaryKeys = new Set();
    for (const [turnId, record] of Object.entries(binding.turnMessages ?? {})) {
      for (const [itemId, entry] of Object.entries(record.assistantEntries ?? {})) {
        const key = `${turnId}:${itemId}`;
        if (!commentaryByKey.has(key) && entry.text) {
          commentaryByKey.set(key, {
            turn: turnsById.get(turnId) ?? { id: turnId, status: record.status },
            item: { id: itemId, phase: entry.phase ?? 'commentary', text: entry.text },
          });
        }
        if (commentaryByKey.has(key)) requiredCommentaryKeys.add(key);
      }
    }
    const activeRecordBeforeSync = activeTurn
      ? this.stateStore.turnRecord(threadId, activeTurn.id) ?? {}
      : {};
    const activeEntryId = Object.entries(activeRecordBeforeSync.assistantEntries ?? {})
      .filter(([, entry]) => (entry.messageIds ?? []).includes(activeRecordBeforeSync.liveMessageId))
      .at(-1)?.[0]
      ?? null;
    const activeAgentItem = activeEntryId
      ? (activeTurn?.items ?? []).find((item) => item.id === activeEntryId)
        ?? commentaryByKey.get(`${activeTurn.id}:${activeEntryId}`)?.item
        ?? null
      : null;
    const activeMessageKey = activeAgentItem ? `${activeTurn.id}:${activeAgentItem.id}` : null;
    const activeReasoningItem = [...(activeTurn?.items ?? [])]
      .reverse()
      .find((item) => item.type === 'reasoning') ?? null;
    const requiredByTurn = new Map();
    for (const key of requiredCommentaryKeys) {
      const value = commentaryByKey.get(key);
      if (!value) continue;
      if (!requiredByTurn.has(value.turn.id)) requiredByTurn.set(value.turn.id, []);
      requiredByTurn.get(value.turn.id).push(value.item);
    }

    const latestCompleted = completedTurns.at(-1);
    if (!activeOnly) {
      for (const turn of completedTurns) {
        if (this.stopping) throw new Error('Transcript reconciliation stopped during Bridge shutdown.');
        const detailItems = includeHistoricalDetails ? historicalAssistantItems(turn) : [];
        const userItems = this.#turnUserItems(turn);
        const recordedOrder = await readSessionTurnCardOrder(thread.path, turn.id, userItems);
        const sessionItems = orderedSessionCardItems(turn, userItems, detailItems, recordedOrder);
        for (const { kind, item } of sessionItems) {
          if (this.stopping) throw new Error('Transcript reconciliation stopped during Bridge shutdown.');
          if (kind === 'user') {
            await this.#ensureTurnUserMessages(binding, turn, channel, messages, [item.id]);
          } else {
            await this.#ensureAssistantMessageCard(binding, turn, item, channel, messages);
          }
        }
        await this.#reconcileCodexImageItems(binding, turn, channel, messages, {
          onlyRecorded: !includeHistoricalDetails,
        });
        const finalText = finalTextFromTurn(
          turn,
          completionTextFromSession(thread.path, turn.id),
        ) || turn.error?.message;
        await this.#ensureTurnFinalMessages(binding, turn, finalText, channel, messages);
      }
    } else if (latestCompleted) {
      // Live notification item IDs can differ from the stable IDs returned by
      // thread/read. Reconcile only the latest completed user cards here so a
      // reconnect converges without backfilling old commentary. Image result
      // blocks in that same latest turn are safe to restore by stable item ID.
      await this.#ensureTurnUserMessages(binding, latestCompleted, channel, messages);
      await this.#reconcileCodexImageItems(binding, latestCompleted, channel, messages);
    }

    if (activeTurn) {
      const restoredStartedAt = activeRecordBeforeSync.startedAt
        ?? turnTimestampMs(activeTurn)
        ?? Date.now();
      const activeDetailItems = includeHistoricalDetails
        ? historicalAssistantItems(activeTurn)
        : requiredByTurn.get(activeTurn.id) ?? [];
      const activeUserItems = this.#turnUserItems(activeTurn);
      const activeRecordedOrder = await readSessionTurnCardOrder(
        thread.path,
        activeTurn.id,
        activeUserItems,
      );
      const activeSessionItems = orderedSessionCardItems(
        activeTurn,
        activeUserItems,
        activeDetailItems,
        activeRecordedOrder,
      );
      for (const { kind, item } of activeSessionItems) {
        if (this.stopping) throw new Error('Transcript reconciliation stopped during Bridge shutdown.');
        if (kind === 'user') {
          await this.#ensureTurnUserMessages(binding, activeTurn, channel, messages, [item.id]);
        } else if (`${activeTurn.id}:${item.id}` !== activeMessageKey) {
          await this.#ensureAssistantMessageCard(binding, activeTurn, item, channel, messages);
        }
      }
      await this.#reconcileCodexImageItems(binding, activeTurn, channel, messages);
      const existingView = this.turnViews.get(`${threadId}:${activeTurn.id}`);
      if (!existingView) {
        const oldRecord = this.stateStore.turnRecord(threadId, activeTurn.id);
        const view = this.#view(threadId, activeTurn.id, binding.channelId);
        view.messageId = oldRecord?.cardMessageId ?? oldRecord?.liveMessageId ?? null;
        view.status = 'inProgress';
        view.startedAt = restoredStartedAt;
        view.currentMessageId = activeAgentItem?.id ?? null;
        view.currentPhase = activeAgentItem?.phase ?? null;
        view.currentMessageCompleted = Boolean(activeAgentItem?.text);
        view.text = activeAgentItem?.text ?? '';
        view.reasoningItemId = activeReasoningItem?.id ?? null;
        view.reasoningPartIndex = null;
        view.reasoning = activeAgentItem && activeReasoningItem
          ? reasoningSummaryFromTurn({ items: [activeReasoningItem] })
          : '';
        await this.#queueTurnViewMutation(
          view,
          () => this.#ensureLiveTurnCard(binding, activeTurn, view, channel, messages),
        );
      } else {
        existingView.startedAt ??= restoredStartedAt;
        await this.#repostLiveTurnCardToLatest(binding, existingView);
      }
      this.#startElapsedUpdates(binding, existingView ?? this.turnViews.get(`${threadId}:${activeTurn.id}`));
    }

    const protectedIds = new Set();
    const latestBinding = this.stateStore.binding(threadId) ?? binding;
    for (const record of Object.values(latestBinding.turnMessages ?? {})) {
      for (const id of record?.userMessageIds ?? []) protectedIds.add(id);
      for (const id of record?.assistantMessageIds ?? []) protectedIds.add(id);
      for (const id of record?.imageMessageIds ?? []) protectedIds.add(id);
      for (const id of record?.finalMessageIds ?? []) protectedIds.add(id);
      for (const entry of Object.values(record?.imageEntries ?? {})) {
        if (entry?.messageId) protectedIds.add(entry.messageId);
      }
      for (const entry of Object.values(record?.compactionEntries ?? {})) {
        if (entry?.messageId) protectedIds.add(entry.messageId);
      }
      if (record?.cardMessageId) protectedIds.add(record.cardMessageId);
      if (record?.liveMessageId) protectedIds.add(record.liveMessageId);
    }
    if (recentSinceMs === null) {
      await this.#cleanupLegacyTranscriptMessages(channel, messages, protectedIds);
    }
    if (activeOnly) return { thread, latestCompleted: completedTurns.at(-1) };
    if (recentSinceMs !== null) {
      const detailItems = [...completedTurns, ...(activeTurn ? [activeTurn] : [])]
        .flatMap((turn) => historicalAssistantItems(turn));
      return {
        thread,
        latestCompleted,
        restoredTurns: completedTurns.length + (activeTurn ? 1 : 0),
        restoredCommentary: detailItems.filter((item) => item.phase === 'commentary').length,
        restoredReasoning: detailItems.filter((item) => item.phase === 'reasoning').length,
      };
    }
    for (const turnId of sessionOrderRepairTurnIds) {
      this.stateStore.setTurnRecord(threadId, turnId, { sessionOrderRepairRequestedAt: null });
    }
    const latestUsers = latestCompleted ? this.#userMessagesFromThread({ turns: [latestCompleted] }) : [];
    this.stateStore.setBinding(threadId, {
      transcriptVersion: 11,
      snapshotInitialized: true,
      lastCompletedTurnId: latestCompleted?.id ?? binding.lastCompletedTurnId ?? null,
      lastCompletionMessageId: this.stateStore.turnRecord(threadId, latestCompleted?.id)?.finalMessageIds?.[0]
        ?? binding.lastCompletionMessageId
        ?? null,
      lastMirroredUserItemId: latestUsers.at(-1)?.id ?? binding.lastMirroredUserItemId ?? null,
    });
    return { thread, latestCompleted };
  }

  #threadEmbed(thread, latestTurn = null) {
    const turn = latestTurn ?? [...(thread.turns ?? [])].reverse()[0];
    return new EmbedBuilder()
      .setTitle(truncate(thread.name ?? thread.preview ?? 'Codex task', 256, ''))
      .setColor(threadStatusLabel(thread.status).startsWith('active') ? COLORS.active : COLORS.neutral)
      .setDescription(truncate(thread.preview ?? '(no preview)', 3000))
      .addFields(
        { name: 'Status', value: threadStatusLabel(thread.status), inline: true },
        { name: 'Latest turn', value: turn ? `${turn.status} / \`${turn.id}\`` : '(none)', inline: true },
        { name: 'Task ID', value: `\`${thread.id}\`` },
        { name: 'CWD', value: `\`${truncate(thread.cwd ?? '(none)', 1000)}\`` },
      )
      .setTimestamp();
  }

  async #prepareAttachments(attachments, threadId, sourceId) {
    if (!attachments?.length) return [];
    const records = await this.incomingAttachmentStore.store({
      threadId,
      sourceId,
      attachments,
    });
    const imageExtension = /\.(?:avif|bmp|gif|jpe?g|png|webp)$/i;
    return records.map((record) => (
      record.contentType?.startsWith('image/') || imageExtension.test(record.name)
        ? { ...record, kind: 'localImage' }
        : { ...record, kind: 'file' }
    ));
  }

  async #readInternalTextAttachment(attachment) {
    const maximumBytes = 5_000_000;
    if (attachment.size > maximumBytes) throw new Error('カード本文添付が大きすぎます。');
    const response = await fetch(attachment.url, {
      signal: AbortSignal.timeout(this.config.discordRestTimeoutMs ?? 300_000),
    });
    if (!response.ok) throw new Error(`カード本文添付を取得できませんでした: HTTP ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maximumBytes) throw new Error('カード本文添付が大きすぎます。');
    return buffer.toString('utf8');
  }

  #textAttachment(text, filename) {
    return new AttachmentBuilder(Buffer.from(String(text), 'utf8'), { name: filename });
  }

  async #handleCodexNotification(message, eventSequence) {
    const threadId = message.params?.threadId ?? message.params?.thread?.id;
    try {
      this.#resolveDelegatedClientToolsFromProgress(message, eventSequence);
      if (message.method === 'serverRequest/resolved') {
        this.#resolveDelegatedClientToolRequest(message.params.requestId);
        const record = [...this.pendingRequests.values()].find((candidate) => String(candidate.request.id) === String(message.params.requestId));
        if (record) await this.#resolvePending(record, '別のCodexクライアントで回答済み', null);
        return;
      }
      if (message.method === 'thread/started') {
        if (this.#isSyncableThread(message.params?.thread)) this.#scheduleTaskSync('thread/started');
        else if (isSubagentCodexThread(message.params?.thread)) {
          await this.#ensureSubagentBinding(message.params.thread.id, { force: true });
        }
        return;
      }
      if (!threadId) return;
      const hiddenBinding = this.stateStore.binding(threadId);
      if (this.#isBindingHidden(hiddenBinding)) {
        if (message.method === 'thread/deleted') {
          this.stateStore.removeBinding(threadId);
          for (const subagent of this.stateStore.subagentThreads?.() ?? []) {
            if (subagent.topLevelParentThreadId === threadId) {
              this.stateStore.removeSubagentThread(subagent.threadId);
            }
          }
        } else if (['thread/archived', 'thread/unarchived', 'thread/name/updated'].includes(message.method)) {
          this.#scheduleTaskSync(message.method);
        }
        return;
      }
      if (['thread/archived', 'thread/unarchived', 'thread/name/updated'].includes(message.method)) {
        this.#scheduleTaskSync(message.method);
        return;
      }
      if (message.method === 'thread/deleted') {
        await this.#moveDeletedTaskToArchive(threadId);
        return;
      }
      let binding = this.stateStore.binding(threadId);
      if (!binding) binding = await this.#ensureSubagentBinding(threadId);
      if (!binding) return;
      if (message.method === 'thread/status/changed' && binding.isSubagent) {
        await this.#ensureSubagentBinding(threadId, { force: true });
        return;
      }
      const turnId = message.params?.turnId ?? message.params?.turn?.id ?? null;
      const turnRecord = turnId ? this.stateStore.turnRecord(threadId, turnId) : null;
      const contextCompactionCompleted = message.method === 'item/completed'
        && message.params?.item?.type === 'contextCompaction';
      const codexImageCompleted = message.method === 'item/completed'
        && hasCodexImageContent(message.params?.item);
      const finalizedTurnUpdate = turnRecord?.status !== 'inProgress'
        && turnRecord?.finalizedAt
        && turnRecord?.finalMessageIds?.length > 0
        && message.method !== 'turn/completed'
        && !contextCompactionCompleted
        && !codexImageCompleted
        && (message.method === 'turn/started'
          || message.method.startsWith('item/')
          || message.method === 'turn/plan/updated'
          || message.method === 'thread/tokenUsage/updated');
      if (finalizedTurnUpdate) {
        if (message.method === 'thread/tokenUsage/updated') {
          this.stateStore.setBinding(threadId, { tokenUsage: message.params.tokenUsage });
        }
        if (!message.method.endsWith('/delta')) {
          this.#log('finalized-turn-update-ignored', { threadId, turnId, method: message.method });
        }
        return;
      }
      if (message.method === 'thread/settings/updated') {
        const settings = message.params.threadSettings ?? {};
        this.stateStore.setBinding(threadId, {
          runtimeSettings: {
            ...binding.runtimeSettings,
            model: settings.model ?? binding.runtimeSettings?.model ?? null,
            effort: settings.effort ?? null,
            serviceTier: settings.serviceTier ?? null,
            approvalPolicy: settings.approvalPolicy ?? null,
            approvalsReviewer: settings.approvalsReviewer ?? null,
            sandbox: settings.sandboxPolicy ?? null,
            activePermissionProfile: settings.activePermissionProfile ?? null,
            collaborationMode: settings.collaborationMode ?? null,
            personality: settings.personality ?? null,
          },
        });
      }
      else if (message.method === 'turn/started') await this.#turnStarted(binding, message.params);
      else if (message.method === 'item/agentMessage/delta') await this.#agentDelta(binding, message.params);
      else if (message.method === 'item/reasoning/summaryPartAdded') {
        this.#reasoningPartAdded(binding, message.params);
      }
      else if (['item/reasoning/summaryTextDelta', 'item/reasoning/textDelta'].includes(message.method)) {
        this.#reasoningDelta(binding, message.params);
      }
      else if (message.method === 'item/started') await this.#itemChanged(binding, message.params, false);
      else if (contextCompactionCompleted) {
        const result = await this.#contextCompactionCompleted(binding, message.params);
        if (result.message && !turnRecord?.finalizedAt) {
          await this.#itemChanged(binding, message.params, true);
          const view = this.turnViews.get(`${binding.threadId}:${turnId}`);
          if (result.created && view?.status === 'inProgress') {
            await this.#repostLiveTurnCardToLatest(binding, view);
          }
        }
      }
      else if (codexImageCompleted) {
        const result = await this.#codexImageCompleted(binding, message.params);
        if (!turnRecord?.finalizedAt) {
          await this.#itemChanged(binding, message.params, true);
          const view = this.turnViews.get(`${binding.threadId}:${turnId}`);
          if (result.created && view?.status === 'inProgress') {
            await this.#repostLiveTurnCardToLatest(binding, view);
          }
        } else if (result.created && !binding.isSubagent) {
          const channel = await this.client.channels.fetch(binding.channelId);
          await this.#repostTaskPanelAfterCompletion(binding.threadId, turnId, channel).catch((error) => {
            this.#log('task-panel-image-repost-failed', {
              threadId: binding.threadId,
              turnId,
              error: error.stack ?? error.message,
            });
          });
        }
      }
      else if (message.method === 'item/completed') await this.#itemChanged(binding, message.params, true);
      else if (message.method === 'turn/plan/updated') this.#planChanged(binding, message.params);
      else if (message.method === 'thread/tokenUsage/updated') this.#tokenUsageChanged(binding, message.params);
      else if (message.method === 'turn/completed') await this.#turnCompleted(binding, message.params);
      else if (message.method === 'error' || message.method === 'warning' || message.method === 'guardianWarning') {
        const retryStatus = message.method === 'error' ? codexRetryStatusText(message.params) : null;
        await this.#postTaskMessage(
          binding,
          retryStatus ?? `**${message.method}**\n${truncate(message.params?.message ?? JSON.stringify(message.params), 1800)}`,
        );
      }
    } catch (error) {
      this.#log('notification-handler-error', { method: message.method, error: error.stack ?? error.message });
      if (message.method === 'turn/completed') {
        this.#scheduleCompletionRecovery(
          threadId,
          message.params?.turn?.id ?? message.params?.turnId ?? null,
          'turn-completed-handler-error',
        );
      }
    }
  }

  #clearCompletionRecovery(threadId, turnId) {
    for (const [key, job] of this.completionRecoveryJobs) {
      if (job.threadId !== threadId || (turnId && job.turnId && job.turnId !== turnId)) continue;
      if (job.timer) clearTimeout(job.timer);
      this.completionRecoveryJobs.delete(key);
    }
  }

  #scheduleCompletionRecovery(threadId, turnId = null, reason = 'unspecified', delayMs = null) {
    if (this.stopping || !threadId || typeof this.codex.readThread !== 'function') return;
    const key = `${threadId}:${turnId ?? 'latest'}`;
    if (this.completionRecoveryJobs.has(key)) return;
    const job = {
      threadId,
      turnId,
      reason,
      attempts: 0,
      timer: null,
      promise: null,
    };
    this.completionRecoveryJobs.set(key, job);

    const run = async () => {
      job.timer = null;
      job.attempts += 1;
      try {
        const binding = this.stateStore.binding(threadId);
        if (!binding || binding.archived) {
          this.completionRecoveryJobs.delete(key);
          return;
        }
        const result = await this.codex.readThread(threadId);
        const turns = result?.thread?.turns ?? [];
        const turn = turnId
          ? turns.find((candidate) => candidate.id === turnId)
          : [...turns].reverse().find((candidate) => candidate.status !== 'inProgress');
        if (!turn || turn.status === 'inProgress') {
          throw new Error(`Completed turn is not persisted yet: ${turnId ?? 'latest'}`);
        }
        await this.#turnCompleted(binding, { threadId, turn });
        this.completionRecoveryJobs.delete(key);
        this.#log('completion-recovery-completed', {
          threadId,
          turnId: turn.id,
          reason,
          attempts: job.attempts,
        });
      } catch (error) {
        if (this.completionRecoveryJobs.get(key) !== job) return;
        if (this.stopping) {
          this.completionRecoveryJobs.delete(key);
          return;
        }
        const retryDelayMs = Math.min(
          this.completionRetryMaxMs,
          this.completionRetryBaseMs * (2 ** Math.min(job.attempts, 8)),
        );
        this.#log('completion-recovery-retry', {
          threadId,
          turnId,
          reason,
          attempts: job.attempts,
          retryDelayMs,
          error: error.stack ?? error.message,
        });
        job.timer = setTimeout(() => {
          job.promise = run();
        }, retryDelayMs);
        job.timer.unref?.();
      }
    };

    this.#log('completion-recovery-scheduled', {
      threadId,
      turnId,
      reason,
      delayMs: delayMs ?? this.completionRetryBaseMs,
    });
    job.timer = setTimeout(() => {
      job.promise = run();
    }, delayMs ?? this.completionRetryBaseMs);
    job.timer.unref?.();
  }

  #queueCodexNotification(message, eventSequence) {
    if (this.stopping) return;
    const threadId = message.params?.threadId ?? message.params?.thread?.id ?? '__global__';
    let buffer = this.notificationBuffers.get(threadId);
    if (!buffer) {
      let resolve;
      const promise = new Promise((complete) => { resolve = complete; });
      buffer = {
        entries: [],
        offset: 0,
        scheduled: false,
        promise,
        resolve,
      };
      this.notificationBuffers.set(threadId, buffer);
      this.notificationQueues.set(threadId, promise);
    }

    const entry = { message, eventSequence };
    const tailIndex = buffer.entries.length - 1;
    const merged = tailIndex >= buffer.offset
      ? coalesceCodexNotification(buffer.entries[tailIndex], entry)
      : null;
    if (merged) buffer.entries[tailIndex] = merged;
    else buffer.entries.push(entry);
    this.#scheduleCodexNotificationDrain(threadId, buffer);
  }

  #scheduleCodexNotificationDrain(threadId, buffer) {
    if (buffer.scheduled) return;
    buffer.scheduled = true;
    setImmediate(() => this.#drainCodexNotifications(threadId, buffer));
  }

  async #drainCodexNotifications(threadId, buffer) {
    const startedAt = Date.now();
    let processed = 0;
    try {
      while (buffer.offset < buffer.entries.length
        && processed < 100
        && Date.now() - startedAt < 8) {
        const entry = buffer.entries[buffer.offset];
        buffer.offset += 1;
        processed += 1;
        await runAfterTranscriptBarrier(
          this.transcriptSyncPromises,
          threadId,
          () => this.#handleCodexNotification(entry.message, entry.eventSequence),
        );
      }
    } catch (error) {
      this.#log('notification-drain-error', {
        threadId,
        error: error.stack ?? error.message,
      });
    }

    if (buffer.offset < buffer.entries.length) {
      if (buffer.offset >= 1_000) {
        buffer.entries.splice(0, buffer.offset);
        buffer.offset = 0;
      }
      setImmediate(() => this.#drainCodexNotifications(threadId, buffer));
      return;
    }

    buffer.scheduled = false;
    if (this.notificationBuffers.get(threadId) === buffer) {
      this.notificationBuffers.delete(threadId);
      if (this.notificationQueues.get(threadId) === buffer.promise) {
        this.notificationQueues.delete(threadId);
      }
    }
    buffer.resolve();
  }

  #queueSubscriptionRestored(event) {
    if (this.stopping) return;
    const threadId = event.binding.threadId;
    const previous = this.subscriptionSyncPromises.get(threadId) ?? Promise.resolve();
    const queued = previous.catch(() => {}).then(async () => {
      if (this.stopping) return;
      try {
        await this.#handleSubscriptionRestored(event);
      } catch (error) {
        this.#log('subscription-sync-error', {
          threadId,
          error: error.stack ?? error.message,
        });
        if (!this.stopping) {
          await this.#postAlert(
            `購読復元後の同期に失敗しました: ${threadId}\n${error.message}`,
            'error',
          ).catch(() => {});
        }
      }
    });
    this.subscriptionSyncPromises.set(threadId, queued);
    queued.finally(() => {
      if (this.subscriptionSyncPromises.get(threadId) === queued) {
        this.subscriptionSyncPromises.delete(threadId);
      }
    });
  }

  #scheduleTaskSync(reason) {
    if (this.stopping || this.taskSyncDebounceTimer) return;
    this.taskSyncDebounceTimer = setTimeout(() => {
      this.taskSyncDebounceTimer = null;
      this.#syncAllTasks().catch((error) => {
        this.#log('task-sync-notification-error', { reason, error: error.stack ?? error.message });
      });
    }, 300);
    this.taskSyncDebounceTimer.unref?.();
  }

  async #moveDeletedTaskToArchive(threadId) {
    const binding = this.stateStore.binding(threadId);
    if (!binding) return;
    const { guild } = await this.infrastructureReady;
    const context = { guild, channels: await guild.channels.fetch() };
    await this.#syncTaskChannel({
      id: threadId,
      name: binding.name,
      preview: binding.name,
      cwd: binding.cwd,
      ephemeral: false,
      parentThreadId: null,
    }, true, context);
    this.stateStore.setBinding(threadId, { deleted: true, archived: true });
  }

  async #turnStarted(binding, params) {
    const turnId = params.turn?.id ?? params.turnId;
    if (binding.isSubagent) await this.#setSubagentDiscordStatus(binding, 'active');
    const view = this.#view(binding.threadId, turnId, binding.channelId);
    view.status = 'inProgress';
    view.startedAt = turnTimestampMs(params.turn ?? { id: turnId }) ?? view.startedAt ?? Date.now();
    const channel = await this.client.channels.fetch(binding.channelId);
    const messages = await this.#fetchChannelHistory(channel, 100);
    await this.#queueTurnViewMutation(
      view,
      () => this.#ensureLiveTurnCard(
        binding,
        { id: turnId, status: 'inProgress' },
        view,
        channel,
        messages,
      ),
    );
    this.#startElapsedUpdates(binding, view);
    this.#scheduleTaskSync('turn/started');
  }

  async #freezeLiveAssistantMessage(binding, view, channel, messages) {
    if (view.currentPhase !== 'commentary' || !view.currentMessageId || !view.messageId) return null;
    if (view.timer) {
      clearTimeout(view.timer);
      view.timer = null;
    }
    const message = await this.#ensureAssistantMessageCard(
      binding,
      { id: view.turnId, status: 'inProgress' },
      {
        id: view.currentMessageId,
        phase: view.currentPhase,
        text: view.text,
      },
      channel,
      messages,
      view.messageId,
    );
    view.messageId = null;
    view.message = null;
    return message;
  }

  #deferAgentMessage(view, item, {
    acceptDeltaAlias = true,
    deltaMessageId = null,
    completed = false,
  } = {}) {
    const existing = view.pendingAgentMessages.get(item.id);
    const pending = existing ?? {
      item: { id: item.id, type: 'agentMessage', phase: item.phase ?? 'commentary', text: '' },
      deltaMessageId: null,
      acceptDeltaAlias,
      completed: false,
    };
    const nextText = String(item.text ?? '');
    pending.item = {
      ...pending.item,
      ...item,
      text: nextText || pending.item.text || '',
    };
    pending.deltaMessageId = deltaMessageId ?? pending.deltaMessageId;
    pending.acceptDeltaAlias = pending.acceptDeltaAlias && acceptDeltaAlias;
    pending.completed ||= completed;
    view.pendingAgentMessages.set(item.id, pending);
    return pending;
  }

  #pendingAgentMessageForDelta(view, itemId, { claimAlias = false } = {}) {
    if (!itemId) return null;
    for (const pending of view.pendingAgentMessages.values()) {
      if (pending.item.id === itemId || pending.deltaMessageId === itemId) return pending;
      if (claimAlias && pending.acceptDeltaAlias) {
        pending.deltaMessageId = itemId;
        pending.acceptDeltaAlias = false;
        return pending;
      }
    }
    return null;
  }

  #removeAssistantEntryIdentity(binding, view, itemId) {
    if (!itemId) return;
    const record = this.stateStore.turnRecord(binding.threadId, view.turnId) ?? {};
    if (!record.assistantEntries?.[itemId]) return;
    const assistantEntries = { ...record.assistantEntries };
    delete assistantEntries[itemId];
    this.stateStore.setTurnRecord(binding.threadId, view.turnId, {
      assistantEntries,
      assistantMessageIds: [...new Set(Object.values(assistantEntries)
        .flatMap((entry) => entry.messageIds ?? []))],
    });
  }

  async #promotePendingAgentMessages(binding, view) {
    while (view.currentMessageCompleted && view.pendingAgentMessages.size > 0) {
      const [pendingId, pending] = view.pendingAgentMessages.entries().next().value;
      view.pendingAgentMessages.delete(pendingId);
      await this.#startAgentMessage(binding, {
        turnId: view.turnId,
        item: pending.item,
      }, view, { acceptDeltaAlias: pending.acceptDeltaAlias, force: true });
      view.deltaMessageId = pending.deltaMessageId;
      view.currentMessageCompleted = pending.completed;
      if (pending.completed) {
        await this.#queueTurnViewMutation(view, () => this.#renderTurn(binding, view));
      }
    }
  }

  async #startAgentMessage(binding, params, view, {
    acceptDeltaAlias = true,
    force = false,
  } = {}) {
    const item = params.item;
    if (!item?.id || view.currentMessageId === item.id) return true;
    if (!force
      && view.currentMessageId
      && view.currentPhase === 'commentary'
      && !view.currentMessageCompleted
      && String(view.text ?? '').length > 0) {
      this.#deferAgentMessage(view, item, { acceptDeltaAlias });
      return false;
    }
    const replaceIncompleteEmpty = !force
      && view.currentMessageId
      && view.currentPhase === 'commentary'
      && !view.currentMessageCompleted
      && String(view.text ?? '').length === 0;
    if (replaceIncompleteEmpty) {
      this.#removeAssistantEntryIdentity(binding, view, view.currentMessageId);
    }
    await this.#queueTurnViewMutation(view, async () => {
      if (!this.#isCurrentLiveTurnView(view)) return;
      const channel = await this.client.channels.fetch(binding.channelId);
      const messages = new Map();
      if (view.message?.id === view.messageId) messages.set(view.message.id, view.message);
      else if (view.messageId) {
        const message = await channel.messages.fetch(view.messageId).catch(() => null);
        if (message) messages.set(message.id, message);
      }
      if (!replaceIncompleteEmpty) {
        await this.#freezeLiveAssistantMessage(binding, view, channel, messages);
      }
      view.currentMessageId = item.id;
      view.currentPhase = item.phase ?? 'commentary';
      view.deltaMessageId = null;
      view.acceptDeltaAlias = acceptDeltaAlias;
      view.currentMessageCompleted = false;
      view.text = item.text ?? '';
      view.currentItem = itemSummary(item);
      await this.#ensureLiveTurnCard(
        binding,
        { id: params.turnId, status: 'inProgress' },
        view,
        channel,
        messages,
      );
    });
    return true;
  }

  async #agentDelta(binding, params) {
    const view = this.#view(binding.threadId, params.turnId, binding.channelId);
    const deltaMessageId = params.itemId ?? null;
    const exactPending = this.#pendingAgentMessageForDelta(view, deltaMessageId);
    if (exactPending) {
      exactPending.item.text += params.delta ?? '';
      if (exactPending.item.text.length > 24_000) {
        exactPending.item.text = exactPending.item.text.slice(-24_000);
      }
      return;
    }
    if (deltaMessageId && !view.currentMessageId) {
      view.currentMessageId = deltaMessageId;
      view.currentPhase = params.phase ?? 'commentary';
      view.deltaMessageId = deltaMessageId;
      view.acceptDeltaAlias = false;
      view.currentMessageCompleted = false;
    } else if (deltaMessageId && view.acceptDeltaAlias) {
      view.deltaMessageId = deltaMessageId;
      view.acceptDeltaAlias = false;
    } else if (deltaMessageId && view.deltaMessageId && view.deltaMessageId !== deltaMessageId) {
      if (!view.currentMessageCompleted) {
        const pendingAlias = this.#pendingAgentMessageForDelta(
          view,
          deltaMessageId,
          { claimAlias: true },
        );
        if (pendingAlias) {
          pendingAlias.item.text += params.delta ?? '';
          if (pendingAlias.item.text.length > 24_000) {
            pendingAlias.item.text = pendingAlias.item.text.slice(-24_000);
          }
          return;
        }
        this.#deferAgentMessage(view, {
          id: deltaMessageId,
          type: 'agentMessage',
          phase: params.phase ?? 'commentary',
          text: params.delta ?? '',
        }, { acceptDeltaAlias: false, deltaMessageId });
        return;
      }
      await this.#startAgentMessage(binding, {
        turnId: params.turnId,
        item: { id: deltaMessageId, type: 'agentMessage', phase: params.phase ?? 'commentary', text: '' },
      }, view, { acceptDeltaAlias: false, force: true });
      view.deltaMessageId = deltaMessageId;
    } else if (deltaMessageId && !view.deltaMessageId && view.currentMessageId !== deltaMessageId) {
      if (!view.currentMessageCompleted) {
        const pendingAlias = this.#pendingAgentMessageForDelta(
          view,
          deltaMessageId,
          { claimAlias: true },
        );
        if (pendingAlias) {
          pendingAlias.item.text += params.delta ?? '';
          if (pendingAlias.item.text.length > 24_000) {
            pendingAlias.item.text = pendingAlias.item.text.slice(-24_000);
          }
          return;
        }
        this.#deferAgentMessage(view, {
          id: deltaMessageId,
          type: 'agentMessage',
          phase: params.phase ?? 'commentary',
          text: params.delta ?? '',
        }, { acceptDeltaAlias: false, deltaMessageId });
        return;
      }
      await this.#startAgentMessage(binding, {
        turnId: params.turnId,
        item: { id: deltaMessageId, type: 'agentMessage', phase: params.phase ?? 'commentary', text: '' },
      }, view, { acceptDeltaAlias: false, force: true });
      view.deltaMessageId = deltaMessageId;
    } else if (deltaMessageId) {
      view.deltaMessageId = deltaMessageId;
    }
    view.currentPhase ??= params.phase ?? 'commentary';
    view.text += params.delta ?? '';
    if (view.text.length > 24_000) view.text = view.text.slice(-24_000);
    this.#scheduleTurnRender(binding, view);
  }

  #selectReasoningItem(view, itemId) {
    if (!itemId || view.reasoningItemId === itemId) return false;
    view.reasoningItemId = itemId;
    view.reasoningPartIndex = null;
    view.reasoning = '';
    return true;
  }

  #reasoningPartAdded(binding, params) {
    const view = this.#view(binding.threadId, params.turnId, binding.channelId);
    this.#selectReasoningItem(view, params.itemId);
    const partIndex = params.summaryIndex ?? params.partIndex ?? null;
    if (view.reasoning
      && (partIndex === null || view.reasoningPartIndex !== partIndex)
      && !view.reasoning.endsWith('\n')) {
      view.reasoning += '\n';
    }
    view.reasoningPartIndex = partIndex;
    view.currentItem = 'reasoning';
    this.#scheduleTurnRender(binding, view);
  }

  #reasoningDelta(binding, params) {
    const view = this.#view(binding.threadId, params.turnId, binding.channelId);
    this.#selectReasoningItem(view, params.itemId);
    const partIndex = params.summaryIndex ?? params.partIndex ?? null;
    if (view.reasoning
      && partIndex !== null
      && view.reasoningPartIndex !== null
      && view.reasoningPartIndex !== partIndex
      && !view.reasoning.endsWith('\n')) {
      view.reasoning += '\n';
    }
    if (partIndex !== null) view.reasoningPartIndex = partIndex;
    view.reasoning += params.delta ?? '';
    if (view.reasoning.length > 12_000) view.reasoning = view.reasoning.slice(-12_000);
    view.currentItem = 'reasoning';
    this.#scheduleTurnRender(binding, view);
  }

  async #itemChanged(binding, params, completed) {
    let userMessageChanged = false;
    if (!completed && params.item?.type === 'userMessage') {
      const text = (params.item.content ?? []).map((part) => part.text ?? '').filter(Boolean).join('\n');
      if (text) {
        const reservation = this.#claimUserInputReservation(
          binding.threadId,
          text,
          params.item.clientId,
        );
        if (reservation) {
          reservation.turnId ??= params.turnId;
          reservation.userItemId ??= params.item.id;
          reservation.text = text;
        }
        let mirrored;
        if (reservation?.state === 'posted'
          && params.item.id
          && reservation.postedItemId !== params.item.id) {
          mirrored = await this.#postUserInput(
            binding.threadId,
            params.turnId,
            params.item.id,
            text,
            reservation.source,
          );
          reservation.postedItemId = params.item.id;
        } else {
          mirrored = reservation
            ? await this.#ensureReservedUserInputPosted(reservation)
            : await this.#postUserInput(binding.threadId, params.turnId, params.item.id, text, 'Codex Desktop');
        }
        if (mirrored && params.item.id) {
          this.stateStore.setBinding(binding.threadId, { lastMirroredUserItemId: params.item.id });
        }
        if (mirrored && reservation) await this.#moveLiveCardAfterReservedInput(reservation);
        userMessageChanged = mirrored && !reservation;
      }
    }
    const view = this.#view(binding.threadId, params.turnId, binding.channelId);
    if (params.item?.type === 'reasoning') {
      this.#selectReasoningItem(view, params.item.id);
      if (completed && params.item.summary?.length) {
        view.reasoning = params.item.summary.map((part) => String(part).trim()).filter(Boolean).join('\n');
        view.reasoningPartIndex = params.item.summary.length - 1;
      }
    }
    if (params.item?.type === 'agentMessage' && !completed) {
      await this.#startAgentMessage(binding, params, view, { acceptDeltaAlias: true });
    }
    const summary = completed ? itemResultSummary(params.item) : itemSummary(params.item);
    view.currentItem = completed ? null : summary;
    if (completed) {
      view.items.push(summary);
      if (view.items.length > 8) view.items.shift();
    }
    if (completed && params.item?.type === 'agentMessage') {
      const itemId = params.item.id ?? view.currentMessageId;
      const isCurrent = itemId === view.currentMessageId || itemId === view.deltaMessageId;
      if (!isCurrent) {
        const pending = view.pendingAgentMessages.get(itemId)
          ?? [...view.pendingAgentMessages.values()]
            .find((candidate) => candidate.deltaMessageId === itemId);
        if (pending) {
          pending.item = { ...pending.item, ...params.item, text: params.item.text ?? pending.item.text };
          pending.completed = true;
          await this.#promotePendingAgentMessages(binding, view);
          return;
        }
        const completedText = String(params.item.text ?? '');
        if (!view.currentMessageCompleted
          && view.currentMessageId
          && view.text
          && completedText.includes(view.text)) {
          this.#removeAssistantEntryIdentity(binding, view, view.currentMessageId);
          view.currentMessageId = itemId;
        } else if (!view.currentMessageCompleted && view.currentMessageId) {
          this.#deferAgentMessage(view, params.item, { acceptDeltaAlias: false, completed: true });
          return;
        } else {
          await this.#startAgentMessage(binding, params, view, {
            acceptDeltaAlias: false,
            force: true,
          });
        }
      }
      view.currentMessageId = itemId;
      view.currentPhase = params.item.phase ?? view.currentPhase;
      view.deltaMessageId = null;
      view.acceptDeltaAlias = false;
      view.text = params.item.text ?? view.text;
      view.currentMessageCompleted = true;
      await this.#queueTurnViewMutation(view, () => this.#renderTurn(binding, view));
      await this.#promotePendingAgentMessages(binding, view);
    } else if (userMessageChanged) await this.#moveLiveTurnCardToLatest(binding, view);
    else if (binding.watchLevel !== 'quiet') this.#scheduleTurnRender(binding, view);
  }

  async #contextCompactionCompleted(binding, params) {
    const turnId = params.turnId ?? params.turn?.id ?? null;
    const itemId = params.item?.id ?? null;
    if (!turnId || !itemId) {
      this.#log('context-compaction-identity-missing', {
        threadId: binding.threadId,
        turnId,
        itemId,
      });
      return { message: null, created: false };
    }

    const channel = await this.client.channels.fetch(binding.channelId);
    const record = this.stateStore.turnRecord(binding.threadId, turnId) ?? {};
    const recorded = record.compactionEntries?.[itemId] ?? null;
    let message = recorded?.messageId
      ? await channel.messages.fetch(recorded.messageId).catch(() => null)
      : null;
    if (!message) {
      const messages = await this.#fetchChannelHistory(channel, 100);
      message = [...messages.values()].find((candidate) => candidate.author.id === this.client.user.id
        && this.#embedTaskId(candidate) === binding.threadId
        && this.#embedTurnId(candidate) === turnId
        && this.#embedContextCompactionItemId(candidate) === itemId) ?? null;
    }

    const completedAt = recorded?.completedAt ?? new Date().toISOString();
    let created = false;
    if (!message) {
      const embed = new EmbedBuilder()
        .setTitle('Codex context compacted')
        .setColor(COLORS.neutral)
        .setDescription('会話履歴のコンテキストがコンパクト化されました。')
        .addFields(
          { name: 'Task', value: `\`${binding.threadId}\`` },
          { name: 'Turn', value: `\`${turnId}\``, inline: true },
          { name: 'Item', value: `\`${itemId}\``, inline: true },
        )
        .setTimestamp(new Date(completedAt));
      message = await channel.send({
        content: '',
        embeds: [embed],
        allowedMentions: { parse: [] },
      });
      created = true;
    }

    const latestRecord = this.stateStore.turnRecord(binding.threadId, turnId) ?? {};
    const compactionEntries = { ...(latestRecord.compactionEntries ?? {}) };
    compactionEntries[itemId] = {
      messageId: message.id,
      completedAt,
    };
    this.stateStore.setTurnRecord(binding.threadId, turnId, { compactionEntries });
    return { message, created };
  }

  async #codexImageCompleted(binding, params) {
    const turnId = params.turnId ?? params.turn?.id ?? null;
    const item = params.item;
    if (!turnId || !item?.id) {
      this.#log('codex-image-identity-missing', {
        threadId: binding.threadId,
        turnId,
        itemId: item?.id ?? null,
      });
      return { message: null, created: false };
    }
    const channel = await this.client.channels.fetch(binding.channelId);
    const messages = await this.#fetchChannelHistory(channel, 100);
    return this.#ensureCodexImageCard(
      binding,
      { id: turnId, status: params.turn?.status ?? 'inProgress' },
      item,
      channel,
      messages,
    );
  }

  #planChanged(binding, params) {
    const view = this.#view(binding.threadId, params.turnId, binding.channelId);
    view.plan = params.plan ?? [];
    if (binding.watchLevel !== 'quiet') this.#scheduleTurnRender(binding, view);
  }

  #tokenUsageChanged(binding, params) {
    const view = this.#view(binding.threadId, params.turnId, binding.channelId);
    view.tokenUsage = params.tokenUsage;
    this.stateStore.setBinding(binding.threadId, { tokenUsage: params.tokenUsage });
    if (binding.watchLevel === 'verbose') this.#scheduleTurnRender(binding, view);
  }

  async #turnCompleted(binding, params) {
    const turnId = params.turn?.id ?? params.turnId;
    const key = `${binding.threadId}:${turnId}`;
    const pending = this.turnCompletionPromises.get(key);
    if (pending) return pending;
    const operation = this.#turnCompletedOnce(binding, params);
    this.turnCompletionPromises.set(key, operation);
    try {
      return await operation;
    } finally {
      if (this.turnCompletionPromises.get(key) === operation) {
        this.turnCompletionPromises.delete(key);
      }
    }
  }

  async #turnCompletedOnce(binding, params) {
    const turn = params.turn;
    const completedRecord = this.stateStore.turnRecord(binding.threadId, turn.id) ?? {};
    if (completedRecord.status !== 'inProgress'
      && completedRecord.finalizedAt
      && completedRecord.finalMessageIds?.[0]) {
      const channel = await this.client.channels.fetch(binding.channelId);
      const completionMessage = await channel.messages.fetch(completedRecord.finalMessageIds[0]).catch(() => null);
      if (completionMessage) {
        const finalText = completedRecord.finalText
          || turn.error?.message
          || 'このターンにはassistantメッセージが記録されていません。';
        this.stateStore.setBinding(binding.threadId, {
          lastCompletedTurnId: turn.id,
          lastCompletionMessageId: completionMessage.id,
          taskStatus: 'idle',
        });
        if (!binding.isSubagent) await this.#repostTaskPanelAfterCompletion(binding.threadId, turn.id, channel).catch((error) => {
          this.#log('task-panel-completion-repost-failed', {
            threadId: binding.threadId,
            turnId: turn.id,
            error: error.stack ?? error.message,
          });
        });
        if (!binding.isSubagent && turn.status === 'completed') {
          const notice = await this.#postCompletionNotice(completionMessage, finalText, binding.threadId, turn.id);
          if (!notice) {
            this.#log('completion-notice-suppressed', {
              threadId: binding.threadId,
              turnId: turn.id,
            });
          }
          this.stateStore.setBinding(binding.threadId, { lastNotifiedCompletedTurnId: turn.id });
        }
        if (binding.isSubagent) await this.#setSubagentDiscordStatus(binding, turn.status ?? 'idle');
        this.#clearCompletionRecovery(binding.threadId, turn.id);
        const completedView = this.turnViews.get(`${binding.threadId}:${turn.id}`);
        if (completedView) {
          completedView.status = turn.status ?? 'completed';
          if (completedView.timer) clearTimeout(completedView.timer);
          if (completedView.elapsedTimer) clearTimeout(completedView.elapsedTimer);
          await completedView.mutationPromise?.catch((error) => this.#log(
            'turn-mutation-before-idempotent-completion-failed',
            {
              threadId: binding.threadId,
              turnId: turn.id,
              error: error.stack ?? error.message,
            },
          ));
        }
        this.turnViews.delete(`${binding.threadId}:${turn.id}`);
        this.#scheduleTaskSync('turn/completed-idempotent');
        return completionMessage;
      }
    }
    const view = this.#view(binding.threadId, turn.id, binding.channelId);
    view.status = turn.status;
    view.completedAt = Date.now();
    if (view.elapsedTimer) {
      clearTimeout(view.elapsedTimer);
      view.elapsedTimer = null;
    }
    if (view.timer) {
      clearTimeout(view.timer);
      view.timer = null;
    }
    if (view.mutationPromise) {
      await view.mutationPromise.catch((error) => this.#log('turn-mutation-before-completion-failed', {
        threadId: binding.threadId,
        turnId: turn.id,
        error: error.stack ?? error.message,
      }));
    }
    const channel = await this.client.channels.fetch(binding.channelId);
    const messages = await this.#fetchChannelHistory(channel, 100);
    const finalLiveMessageId = view.currentPhase === 'commentary' ? null : view.messageId;
    if (view.currentPhase === 'commentary') {
      await this.#freezeLiveAssistantMessage(binding, view, channel, messages);
    }
    let sessionPath = binding.sessionPath;
    if (!sessionPath) {
      const result = await this.codex.threadMetadata(binding.threadId).catch(() => null);
      sessionPath = result?.thread?.path ?? null;
      if (sessionPath) this.stateStore.setBinding(binding.threadId, { sessionPath });
    }
    let completionText = completionTextFromSession(sessionPath, turn.id);
    if (!completionText && !(turn.items ?? []).some((item) => item.type === 'agentMessage' && item.phase === 'final_answer')) {
      await sleep(100);
      completionText = completionTextFromSession(sessionPath, turn.id);
    }
    view.text = finalTextFromTurn(turn, completionText)
      || turn.error?.message
      || 'このターンにはassistantメッセージが記録されていません。';
    let stableTurn = turn;
    if (typeof this.codex.readThread === 'function') {
      const persisted = await this.codex.readThread(binding.threadId).catch(() => null);
      const persistedTurn = persisted?.thread?.turns?.find((candidate) => candidate.id === turn.id);
      if (persistedTurn?.items?.length) stableTurn = { ...turn, items: persistedTurn.items };
    }
    await this.#ensureTurnUserMessages(binding, stableTurn, channel, messages);
    await this.#reconcileStableAssistantMessages(binding, stableTurn, channel, messages);
    await this.#reconcileCodexImageItems(binding, stableTurn, channel, messages);
    const finalText = view.text;
    const completionMessage = await this.#ensureTurnFinalMessages(
      binding,
      stableTurn,
      finalText,
      channel,
      messages,
      finalLiveMessageId,
    );
    this.stateStore.setBinding(binding.threadId, {
      lastCompletedTurnId: turn.id,
      lastCompletionMessageId: completionMessage.id,
      taskStatus: 'idle',
    });
    if (!binding.isSubagent) await this.#repostTaskPanelAfterCompletion(binding.threadId, turn.id, channel).catch((error) => {
      this.#log('task-panel-completion-repost-failed', {
        threadId: binding.threadId,
        turnId: turn.id,
        error: error.stack ?? error.message,
      });
    });
    if (!binding.isSubagent && turn.status === 'completed') {
      const notice = await this.#postCompletionNotice(completionMessage, finalText, binding.threadId, turn.id);
      if (!notice) {
        this.#log('completion-notice-suppressed', {
          threadId: binding.threadId,
          turnId: turn.id,
        });
      }
      this.stateStore.setBinding(binding.threadId, { lastNotifiedCompletedTurnId: turn.id });
    }
    if (binding.isSubagent) await this.#setSubagentDiscordStatus(binding, turn.status ?? 'idle');
    this.#clearCompletionRecovery(binding.threadId, turn.id);
    this.turnViews.delete(`${binding.threadId}:${turn.id}`);
    this.#scheduleTaskSync('turn/completed');
  }

  async #postCompletionNotice(completionMessage, finalText, threadId, turnId) {
    const key = `${threadId}:${turnId}`;
    const pending = this.completionNoticePromises.get(key);
    if (pending) return pending;
    const operation = this.#postCompletionNoticeOnce(completionMessage, finalText, threadId, turnId);
    this.completionNoticePromises.set(key, operation);
    try {
      return await operation;
    } finally {
      if (this.completionNoticePromises.get(key) === operation) {
        this.completionNoticePromises.delete(key);
      }
    }
  }

  async #postCompletionNoticeOnce(completionMessage, finalText, threadId, turnId) {
    const binding = this.stateStore.binding(threadId);
    if (this.#isBindingHidden(binding) || binding?.completionReportsEnabled === false) return null;
    const { completions } = await this.infrastructureReady;
    const record = this.stateStore.turnRecord(threadId, turnId) ?? {};
    let notice = record.completionNoticeMessageId
      ? await completions.messages.fetch(record.completionNoticeMessageId).catch(() => null)
      : null;
    if (!notice) {
      const recent = await completions.messages.fetch({ limit: 100 });
      notice = recent.find((message) => message.author.id === this.client.user.id
        && message.content.includes(completionMessage.url));
    }
    if (notice) {
      this.stateStore.setTurnRecord(threadId, turnId, { completionNoticeMessageId: notice.id });
      return notice;
    }
    const mentionUserIds = this.completionMentionUserIds;
    notice = await completions.send({
      content: completionNoticeContent(mentionUserIds, completionMessage.url, finalText),
      allowedMentions: { parse: [], users: mentionUserIds },
    });
    this.stateStore.setTurnRecord(threadId, turnId, { completionNoticeMessageId: notice.id });
    return notice;
  }

  #view(threadId, turnId, channelId) {
    const key = `${threadId}:${turnId}`;
    if (!this.turnViews.has(key)) {
      const record = this.stateStore.turnRecord(threadId, turnId) ?? {};
      this.turnViews.set(key, {
        key,
        threadId,
        turnId,
        channelId,
        messageId: record.cardMessageId
          ?? record.liveMessageId
          ?? null,
        message: null,
        startedAt: record.startedAt ?? uuidV7TimestampMs(turnId) ?? Date.now(),
        currentMessageId: null,
        currentPhase: null,
        deltaMessageId: null,
        acceptDeltaAlias: false,
        currentMessageCompleted: false,
        pendingAgentMessages: new Map(),
        text: '',
        reasoning: '',
        reasoningItemId: null,
        reasoningPartIndex: null,
        currentItem: null,
        items: [],
        plan: [],
        tokenUsage: null,
        status: 'inProgress',
        timer: null,
        elapsedTimer: null,
        renderPromise: null,
        mutationPromise: null,
      });
    }
    return this.turnViews.get(key);
  }

  #scheduleTurnRender(binding, view) {
    if (this.stopping || view.status !== 'inProgress' || view.timer || view.renderPromise) return;
    view.timer = setTimeout(() => {
      view.timer = null;
      const renderPromise = this.#queueTurnViewMutation(
        view,
        () => this.#renderTurn(binding, view),
      );
      view.renderPromise = renderPromise;
      renderPromise
        .catch((error) => this.#log('turn-render-failed', { error: error.message }))
        .finally(() => {
          if (view.renderPromise === renderPromise) view.renderPromise = null;
        });
    }, this.config.liveUpdateIntervalMs);
    view.timer.unref?.();
  }

  #startElapsedUpdates(binding, view) {
    if (!view || this.stopping || view.status !== 'inProgress' || view.elapsedTimer) return;
    const intervalMs = Math.max(100, this.config.elapsedUpdateIntervalMs ?? 10_000);
    view.elapsedTimer = setTimeout(() => {
      view.elapsedTimer = null;
      if (this.stopping || view.status !== 'inProgress' || this.turnViews.get(view.key) !== view) return;
      const currentBinding = this.stateStore.binding(view.threadId) ?? binding;
      this.#scheduleTurnRender(currentBinding, view);
      this.#startElapsedUpdates(currentBinding, view);
    }, intervalMs);
    view.elapsedTimer.unref?.();
  }

  async #renderTurn(binding, view) {
    if (!this.#isCurrentLiveTurnView(view)) return null;
    const channel = await this.client.channels.fetch(binding.channelId);
    let message = null;
    const components = contentCardComponents(extractLocalFileReferences(view.text).length);
    if (!view.messageId) {
      const messages = await this.#fetchChannelHistory(channel, 100);
      return this.#ensureLiveTurnCard(
        binding,
        { id: view.turnId, status: 'inProgress' },
        view,
        channel,
        messages,
      );
    } else {
      message = view.message?.id === view.messageId
        ? view.message
        : await channel.messages.fetch(view.messageId).catch(() => null);
      if (!message) {
        view.messageId = null;
        view.message = null;
        return this.#renderTurn(binding, view);
      }
      await message.edit({
        content: '',
        embeds: [this.#turnEmbed(view)],
        components,
        attachments: [],
        allowedMentions: { parse: [] },
      });
    }
    view.messageId = message.id;
    view.message = message;
    const record = this.stateStore.turnRecord(binding.threadId, view.turnId) ?? {};
    const patch = {
      cardMessageId: message.id,
      liveMessageId: message.id,
      status: 'inProgress',
      startedAt: view.startedAt,
    };
    if (view.currentPhase === 'commentary' && view.currentMessageId) {
      const assistantEntries = { ...(record.assistantEntries ?? {}) };
      assistantEntries[view.currentMessageId] = {
        text: view.text,
        phase: view.currentPhase,
        messageIds: [message.id],
      };
      patch.assistantEntries = assistantEntries;
      patch.assistantMessageIds = [...new Set(Object.values(assistantEntries)
        .flatMap((entry) => entry.messageIds ?? []))];
    }
    this.stateStore.setTurnRecord(binding.threadId, view.turnId, patch);
  }

  async #moveLiveTurnCardToLatest(binding, view) {
    return this.#queueLiveCardMove(
      binding,
      view,
      () => this.#queueTurnViewMutation(
        view,
        () => this.#moveLiveTurnCardToLatestOnce(binding, view),
      ),
    );
  }

  async #moveLiveTurnCardToLatestOnce(binding, view) {
    if (!this.#isCurrentLiveTurnView(view)) return null;
    if (view.timer) {
      clearTimeout(view.timer);
      view.timer = null;
    }
    const channel = await this.client.channels.fetch(binding.channelId);
    const messages = await this.#fetchChannelHistory(channel, 100);
    if (view.currentPhase === 'commentary') {
      await this.#freezeLiveAssistantMessage(binding, view, channel, messages);
    } else if (view.messageId) {
      const message = await channel.messages.fetch(view.messageId).catch(() => null);
      if (message?.author.id === this.client.user.id) await message.delete().catch(() => {});
    }
    await this.#deleteDuplicateLiveTurnCards(binding, view.turnId, messages);
    view.messageId = null;
    view.message = null;
    view.currentMessageId = null;
    view.currentPhase = null;
    view.deltaMessageId = null;
    view.acceptDeltaAlias = false;
    view.currentMessageCompleted = false;
    view.pendingAgentMessages.clear();
    view.text = '';
    view.reasoning = '';
    view.reasoningItemId = null;
    view.reasoningPartIndex = null;
    this.stateStore.setTurnRecord(binding.threadId, view.turnId, {
      cardMessageId: null,
      liveMessageId: null,
    });
    await this.#renderTurn(binding, view);
  }

  async #repostLiveTurnCardToLatest(binding, view) {
    return this.#queueLiveCardMove(binding, view, async () => {
      await this.#queueTurnViewMutation(view, async () => {
        if (!this.#isCurrentLiveTurnView(view)) return;
        if (view.timer) {
          clearTimeout(view.timer);
          view.timer = null;
        }
        const channel = await this.client.channels.fetch(binding.channelId);
        const messages = await this.#fetchChannelHistory(channel, 100);
        await this.#deleteDuplicateLiveTurnCards(binding, view.turnId, messages);
        view.messageId = null;
        view.message = null;
        this.stateStore.setTurnRecord(binding.threadId, view.turnId, {
          cardMessageId: null,
          liveMessageId: null,
        });
        await this.#renderTurn(binding, view);
      });
    });
  }

  #isCurrentLiveTurnView(view) {
    return !this.stopping
      && view?.status === 'inProgress'
      && this.turnViews.get(view.key) === view;
  }

  #queueTurnViewMutation(view, operation) {
    const previous = view.mutationPromise ?? Promise.resolve();
    const queued = previous.catch(() => {}).then(operation);
    view.mutationPromise = queued;
    const clear = () => {
      if (view.mutationPromise === queued) view.mutationPromise = null;
    };
    queued.then(clear, clear);
    return queued;
  }

  async #deleteDuplicateLiveTurnCards(binding, turnId, messages, keepMessageId = null) {
    const deletedIds = new Set();
    for (const message of [...messages.values()]) {
      if (message.id === keepMessageId || message.author.id !== this.client.user.id) continue;
      if (this.#embedTaskId(message) !== binding.threadId || this.#embedTurnId(message) !== turnId) continue;
      if (!message.embeds.some((embed) => embed.title === 'Codex running')) continue;
      await message.delete().catch((error) => {
        if (error.code !== 10008) throw error;
      });
      messages.delete(message.id);
      deletedIds.add(message.id);
    }
    if (deletedIds.size > 0) {
      const record = this.stateStore.turnRecord(binding.threadId, turnId) ?? {};
      const assistantEntries = { ...(record.assistantEntries ?? {}) };
      for (const [itemId, entry] of Object.entries(assistantEntries)) {
        const messageIds = (entry.messageIds ?? []).filter((id) => !deletedIds.has(id));
        if (messageIds.length === 0 && !String(entry.text ?? '').trim()) delete assistantEntries[itemId];
        else assistantEntries[itemId] = { ...entry, messageIds };
      }
      this.stateStore.setTurnRecord(binding.threadId, turnId, {
        assistantEntries,
        assistantMessageIds: [...new Set(Object.values(assistantEntries)
          .flatMap((entry) => entry.messageIds ?? []))],
        ...(deletedIds.has(record.cardMessageId) ? { cardMessageId: null } : {}),
        ...(deletedIds.has(record.liveMessageId) ? { liveMessageId: null } : {}),
      });
    }
  }

  async #reconcileRestoredLiveTurnCards(binding, thread, channel) {
    if (this.stopping || !Array.isArray(thread.turns)) return;
    const recentMessages = await channel.messages.fetch({ limit: 100 });
    const messages = new Map(recentMessages);
    const activeTurn = [...thread.turns].reverse().find((turn) => turn.status === 'inProgress') ?? null;
    const activeRecord = activeTurn
      ? this.stateStore.turnRecord(binding.threadId, activeTurn.id) ?? {}
      : {};
    const finalizedActiveSnapshot = Boolean(
      activeRecord.finalizedAt
      && activeRecord.status !== 'inProgress'
      && activeRecord.finalMessageIds?.length,
    );
    const liveByTurn = new Map();
    for (const message of messages.values()) {
      if (message.author.id !== this.client.user.id
        || this.#embedTaskId(message) !== binding.threadId
        || !message.embeds.some((embed) => embed.title === 'Codex running')) continue;
      const turnId = this.#embedTurnId(message);
      if (!turnId) continue;
      if (!liveByTurn.has(turnId)) liveByTurn.set(turnId, []);
      liveByTurn.get(turnId).push(message);
    }

    let keepMessageId = null;
    if (activeTurn && !finalizedActiveSnapshot) {
      const activeCards = liveByTurn.get(activeTurn.id) ?? [];
      keepMessageId = [activeRecord.liveMessageId, activeRecord.cardMessageId]
        .find((messageId) => activeCards.some((message) => message.id === messageId))
        ?? activeCards.reduce((latest, candidate) => {
          if (!latest) return candidate;
          const latestTimestamp = latest.createdTimestamp ?? 0;
          const candidateTimestamp = candidate.createdTimestamp ?? 0;
          return candidateTimestamp >= latestTimestamp ? candidate : latest;
        }, null)?.id
        ?? null;
    }

    let removed = 0;
    for (const [turnId, liveCards] of liveByTurn) {
      const keepForTurn = turnId === activeTurn?.id ? keepMessageId : null;
      const before = liveCards.filter((message) => message.id !== keepForTurn).length;
      await this.#deleteDuplicateLiveTurnCards(binding, turnId, messages, keepForTurn);
      removed += before;
    }
    if (keepMessageId) {
      this.stateStore.setTurnRecord(binding.threadId, activeTurn.id, {
        cardMessageId: keepMessageId,
        liveMessageId: keepMessageId,
        status: 'inProgress',
      });
    }
    const latestCompletedTurn = [...thread.turns].reverse()
      .find((turn) => turn.status !== 'inProgress') ?? null;
    if (latestCompletedTurn) {
      await this.#pruneSupersededAssistantEntries(
        binding,
        latestCompletedTurn,
        channel,
        messages,
        { requireStableCoverage: true },
      );
    }
    if (removed > 0) {
      this.#log('restored-live-card-reconciled', {
        threadId: binding.threadId,
        activeTurnId: activeTurn?.id ?? null,
        keptMessageId: keepMessageId,
        removed,
      });
    }
  }

  async #queueLiveCardMove(binding, view, operation) {
    const key = `${binding.threadId}:${view.turnId}`;
    const previous = this.liveCardMovePromises.get(key) ?? Promise.resolve();
    const queued = previous.catch(() => {}).then(operation);
    this.liveCardMovePromises.set(key, queued);
    try {
      return await queued;
    } finally {
      if (this.liveCardMovePromises.get(key) === queued) this.liveCardMovePromises.delete(key);
    }
  }

  #turnEmbed(view) {
    const now = Date.now();
    const elapsed = Math.max(0, Math.round(((view.completedAt ?? now) - (view.startedAt ?? now)) / 1000));
    const embed = new EmbedBuilder()
      .setTitle(view.status === 'inProgress' ? 'Codex running' : `Codex ${view.status}`)
      .setColor(view.status === 'inProgress' ? COLORS.active : COLORS.completed)
      .setDescription(truncate(view.text || '(assistant出力待ち)', 2400))
      .addFields(
        { name: 'Task', value: `\`${view.threadId}\`` },
        { name: 'Turn', value: `\`${view.turnId}\``, inline: true },
        { name: 'Message', value: view.currentMessageId ? `\`${view.currentMessageId}\`` : '(pending)', inline: true },
        { name: 'Elapsed', value: `${elapsed}s`, inline: true },
      );
    if (view.reasoning) {
      embed.addFields({ name: 'Reasoning', value: formatReasoningField(view.reasoning, 900, 4) });
    } else if (view.currentItem === 'reasoning') {
      embed.addFields({ name: 'Reasoning', value: '推論中...' });
    }
    if (view.currentItem) embed.addFields({ name: 'Current', value: truncate(view.currentItem, 600) });
    if (view.plan.length) {
      embed.addFields({
        name: 'Plan',
        value: truncate(view.plan.map((item) => `${item.status === 'completed' ? '[x]' : item.status === 'inProgress' ? '[>]' : '[ ]'} ${item.step}`).join('\n'), 700),
      });
    }
    if (view.tokenUsage?.total) {
      embed.setFooter({ text: `tokens ${view.tokenUsage.total.totalTokens} / context ${view.tokenUsage.modelContextWindow ?? '?'}` });
    }
    return embed.setTimestamp();
  }

  async #handleServerRequest(request, eventSequence) {
    try {
      const threadId = request.params?.threadId;
      const binding = threadId ? this.stateStore.binding(threadId) : null;
      if (request.method === 'currentTime/read') {
        this.codex.respondToServerRequest(request.id, { currentTimeAt: Math.floor(Date.now() / 1000) });
        this.#log('current-time-answered', { requestId: request.id, threadId });
        return;
      }
      if (request.method === 'item/tool/call') {
        const namespace = request.params?.namespace ?? 'default';
        const tool = request.params?.tool ?? 'unknown';
        if (requiresExclusiveClientToolOwner(namespace, tool)) {
          await this.#handleExclusiveClientToolRequest(
            request,
            namespace,
            tool,
            threadId,
            binding,
            eventSequence,
          );
        } else {
          await this.#executeClientToolRequest(request, namespace, tool, threadId, binding, null);
        }
        return;
      }
      if (this.#isBindingHidden(binding)) {
        this.#log('hidden-project-server-request-not-mirrored', {
          method: request.method,
          requestId: request.id,
          threadId,
        });
        return;
      }
      if (!binding) {
        this.#log('unrouted-server-request', { method: request.method, requestId: request.id, threadId });
        return;
      }
      const supported = [
        'item/commandExecution/requestApproval',
        'item/fileChange/requestApproval',
        'item/permissions/requestApproval',
        'item/tool/requestUserInput',
        'mcpServer/elicitation/request',
      ];
      if (!supported.includes(request.method)) {
        this.#log('unsupported-server-request', { method: request.method, requestId: request.id, threadId });
        this.codex.rejectServerRequest(
          request.id,
          -32601,
          `Codex Discord Remote cannot fulfill client-side request ${request.method}.`,
        );
        await this.#postTaskMessage(binding, `**Unsupported client request**\n\`${request.method}\` was rejected so the turn does not hang.`);
        return;
      }
      const key = randomKey();
      const record = {
        key,
        request,
        method: request.method,
        threadId,
        channelId: binding.channelId,
        messageId: null,
        answers: {},
        createdAt: Date.now(),
      };
      this.pendingRequests.set(key, record);
      this.#ensureControlPanel().catch((error) => {
        this.#log('control-panel-pending-update-failed', { error: error.message });
      });
      const payload = this.#serverRequestMessage(record);
      const channel = await this.client.channels.fetch(binding.channelId);
      const posted = await channel.send({ ...payload, allowedMentions: { parse: [] } });
      record.messageId = posted.id;
      this.#log('server-request-posted', { key, method: request.method, threadId, messageId: posted.id });
    } catch (error) {
      this.#log('server-request-handler-failed', { method: request.method, error: error.stack ?? error.message });
    }
  }

  async #handleExclusiveClientToolRequest(
    request,
    namespace,
    tool,
    threadId,
    binding,
    eventSequence,
  ) {
    let ownership;
    try {
      ownership = this.desktopClientInspector({
        launcherStatePath: this.config.launcherStatePath,
        appServerUrl: this.codex.status?.().endpoint ?? this.config.appServerUrl,
      });
    } catch (error) {
      ownership = { state: 'ambiguous', generation: null, reason: `inspection-error:${error.message}` };
    }
    const ledgerKey = ownership.generation
      ? clientToolRequestKey(ownership.generation, request.id)
      : null;
    const pendingKey = String(request.id);
    if (this.pendingClientToolRequests.has(pendingKey)) {
      this.#log('client-tool-delegation-duplicate', { requestId: request.id, threadId, namespace, tool });
      return;
    }
    const prior = ledgerKey ? this.stateStore.clientToolRequest?.(ledgerKey) : null;
    if (prior?.response) {
      this.codex.respondToServerRequest(request.id, prior.response);
      this.#log('client-tool-response-replayed', {
        requestId: request.id,
        threadId,
        namespace,
        tool,
        priorStatus: prior.status,
      });
      return;
    }
    if (prior?.status?.startsWith('resolved-by-desktop')) {
      this.#log('client-tool-already-resolved', { requestId: request.id, threadId, namespace, tool });
      return;
    }
    if (prior?.status === 'delegated') {
      const response = this.#clientToolFailure(
        'The Discord bridge cannot safely execute this client tool because it was delegated before reconnect and the Desktop outcome is unknown.',
      );
      this.#setClientToolRequest(ledgerKey, { status: 'failed-closed', response });
      this.codex.respondToServerRequest(request.id, response);
      this.#log('client-tool-delegated-retry-blocked', {
        requestId: request.id,
        threadId,
        namespace,
        tool,
      });
      return;
    }
    if (prior?.status === 'executing') {
      const response = this.#clientToolFailure(
        'The Discord bridge cannot safely retry this client tool because its previous execution outcome is unknown.',
      );
      this.#setClientToolRequest(ledgerKey, { status: 'failed-closed', response });
      this.codex.respondToServerRequest(request.id, response);
      this.#log('client-tool-retry-blocked', { requestId: request.id, threadId, namespace, tool });
      return;
    }
    if (ownership.state === 'absent') {
      await this.#executeClientToolRequest(request, namespace, tool, threadId, binding, ledgerKey);
      return;
    }

    this.#setClientToolRequest(ledgerKey, {
      status: 'delegated',
      threadId,
      namespace,
      tool,
      ownership: ownership.state,
      reason: ownership.reason,
    });
    const timer = setTimeout(() => {
      this.#expireDelegatedClientToolRequest(pendingKey).catch((error) => {
        this.#log('client-tool-delegation-timeout-error', {
          requestId: request.id,
          error: error.stack ?? error.message,
        });
      });
    }, this.clientToolOwnerTimeoutMs);
    timer.unref?.();
    this.pendingClientToolRequests.set(pendingKey, {
      request,
      ledgerKey,
      namespace,
      tool,
      threadId,
      turnId: request.params?.turnId ?? null,
      eventSequence,
      timer,
      ownership,
    });
    this.#log('client-tool-delegated-to-desktop', {
      requestId: request.id,
      threadId,
      namespace,
      tool,
      ownership: ownership.state,
      reason: ownership.reason,
      timeoutMs: this.clientToolOwnerTimeoutMs,
    });
  }

  #resolveDelegatedClientToolRequest(requestId) {
    const pendingKey = String(requestId);
    const record = this.pendingClientToolRequests.get(pendingKey);
    if (!record) return;
    clearTimeout(record.timer);
    this.pendingClientToolRequests.delete(pendingKey);
    this.#setClientToolRequest(record.ledgerKey, {
      status: 'resolved-by-desktop',
      response: null,
    });
    this.#log('client-tool-resolved-by-desktop', {
      requestId,
      threadId: record.threadId,
      namespace: record.namespace,
      tool: record.tool,
    });
  }

  #resolveDelegatedClientToolsFromProgress(message, eventSequence) {
    if (!['item/completed', 'item/started', 'turn/completed'].includes(message.method)) return;
    const threadId = message.params?.threadId ?? message.params?.thread?.id;
    const turnId = message.params?.turnId ?? message.params?.turn?.id ?? null;
    if (!threadId) return;
    for (const [pendingKey, record] of this.pendingClientToolRequests) {
      if (!record.timer || record.threadId !== threadId) continue;
      if (eventSequence <= record.eventSequence) continue;
      if (record.turnId && turnId && record.turnId !== turnId) continue;
      clearTimeout(record.timer);
      this.pendingClientToolRequests.delete(pendingKey);
      this.#setClientToolRequest(record.ledgerKey, {
        status: 'resolved-by-desktop-progress',
        response: null,
      });
      this.#log('client-tool-resolved-by-desktop-progress', {
        requestId: record.request.id,
        threadId: record.threadId,
        turnId: record.turnId,
        namespace: record.namespace,
        tool: record.tool,
        progressMethod: message.method,
      });
    }
  }

  #clearPendingClientToolRequests(reason) {
    const count = this.pendingClientToolRequests.size;
    for (const record of this.pendingClientToolRequests.values()) {
      if (record.timer) clearTimeout(record.timer);
    }
    this.pendingClientToolRequests.clear();
    if (count > 0) this.#log('client-tool-pending-cleared', { reason, count });
  }

  async #expireDelegatedClientToolRequest(pendingKey) {
    const record = this.pendingClientToolRequests.get(pendingKey);
    if (!record) return;
    this.pendingClientToolRequests.delete(pendingKey);
    const response = this.#clientToolFailure(
      `No exclusive Desktop client-tool owner resolved the request within ${this.clientToolOwnerTimeoutMs} ms. The Discord bridge did not execute it.`,
    );
    this.#setClientToolRequest(record.ledgerKey, { status: 'failed-closed', response });
    try {
      this.codex.respondToServerRequest(record.request.id, response);
    } catch (error) {
      this.#log('client-tool-timeout-response-error', {
        requestId: record.request.id,
        error: error.message,
      });
    }
    this.#log('client-tool-delegation-timed-out', {
      requestId: record.request.id,
      threadId: record.threadId,
      namespace: record.namespace,
      tool: record.tool,
      ownership: record.ownership.state,
      reason: record.ownership.reason,
    });
    await this.#postAlert(
      `Client toolを安全に実行できませんでした。\n\`${record.namespace}/${record.tool}\`\nDesktopの実行確認が${Math.round(this.clientToolOwnerTimeoutMs / 60_000)}分以内に取れなかったため、Bridgeは副作用を実行していません。`,
      'error',
    ).catch(() => {});
  }

  #clientToolFailure(message) {
    return {
      success: false,
      contentItems: [{ type: 'inputText', text: message }],
    };
  }

  #setClientToolRequest(ledgerKey, patch) {
    if (ledgerKey) this.stateStore.setClientToolRequest?.(ledgerKey, patch);
  }

  async #executeClientToolRequest(request, namespace, tool, threadId, binding, ledgerKey) {
    this.#setClientToolRequest(ledgerKey, {
      status: 'executing',
      threadId,
      namespace,
      tool,
    });
    const pendingKey = String(request.id);
    this.pendingClientToolRequests.set(pendingKey, {
      request,
      ledgerKey,
      namespace,
      tool,
      threadId,
      timer: null,
      ownership: { state: 'absent', reason: 'bridge-fallback' },
    });
    try {
      let response;
      try {
        const result = await this.clientToolRouter.execute(
          namespace,
          tool,
          request.params?.arguments,
          { threadId },
        );
        response = {
          success: true,
          contentItems: [{ type: 'inputText', text: JSON.stringify(result) }],
        };
        this.#setClientToolRequest(ledgerKey, { status: 'completed', response });
        this.codex.respondToServerRequest(request.id, response);
        this.#log('client-tool-completed', {
          requestId: request.id,
          threadId,
          namespace,
          tool,
        });
      } catch (error) {
        response = this.#clientToolFailure(error.message);
        this.#setClientToolRequest(ledgerKey, { status: 'failed', response });
        this.codex.respondToServerRequest(request.id, response);
        this.#log('client-tool-failed', {
          requestId: request.id,
          threadId,
          namespace,
          tool,
          unavailable: error instanceof ClientToolUnavailableError,
          error: error.message,
        });
        if (binding && error instanceof ClientToolUnavailableError) {
          await this.#postTaskMessage(
            binding,
            `**Client tool unavailable through Discord**\n\`${namespace}/${tool}\`\n${error.message}`,
          );
        }
      }
    } finally {
      if (this.pendingClientToolRequests.get(pendingKey)?.request === request) {
        this.pendingClientToolRequests.delete(pendingKey);
      }
    }
  }

  #serverRequestMessage(record) {
    const { method, request, key } = record;
    const params = request.params;
    if (method === 'item/commandExecution/requestApproval') {
      const embed = new EmbedBuilder().setTitle('Command approval required').setColor(COLORS.warning)
        .setDescription(`\`\`\`powershell\n${truncate(params.command ?? '(command unavailable)', 3500).replaceAll('```', '``\\`')}\n\`\`\``)
        .addFields(
          { name: 'CWD', value: `\`${truncate(params.cwd ?? '(none)', 1000)}\`` },
          { name: 'Reason', value: truncate(params.reason ?? '(none)', 1024) },
        )
        .setFooter({ text: `task ${record.threadId}` });
      if (params.networkApprovalContext) embed.addFields({ name: 'Network', value: `${params.networkApprovalContext.protocol}://${params.networkApprovalContext.host}` });
      const decisions = params.availableDecisions ?? ['accept', 'acceptForSession', 'decline', 'cancel'];
      const supports = (name) => decisions.some((decision) => decision === name
        || (decision && typeof decision === 'object' && Object.hasOwn(decision, name)));
      const buttons = [];
      if (supports('accept')) buttons.push(new ButtonBuilder().setCustomId(`cx:req:${key}:accept`).setLabel('今回のみ許可').setStyle(ButtonStyle.Success));
      if (supports('acceptForSession')) buttons.push(new ButtonBuilder().setCustomId(`cx:req:${key}:acceptForSession`).setLabel('セッション中許可').setStyle(ButtonStyle.Primary));
      if (supports('acceptWithExecpolicyAmendment') && params.proposedExecpolicyAmendment) buttons.push(new ButtonBuilder().setCustomId(`cx:req:${key}:execPolicy`).setLabel('規則として許可').setStyle(ButtonStyle.Primary));
      if (supports('decline')) buttons.push(new ButtonBuilder().setCustomId(`cx:req:${key}:decline`).setLabel('拒否').setStyle(ButtonStyle.Secondary));
      if (supports('cancel')) buttons.push(new ButtonBuilder().setCustomId(`cx:req:${key}:cancel`).setLabel('拒否して停止').setStyle(ButtonStyle.Danger));
      if (!buttons.length) throw new Error('app-server returned no supported approval decisions.');
      const rows = [new ActionRowBuilder().addComponents(buttons.slice(0, 5))];
      const amendments = params.proposedNetworkPolicyAmendments ?? [];
      if (amendments.length) {
        rows.push(new ActionRowBuilder().addComponents(amendments.slice(0, 5).map((amendment, index) => new ButtonBuilder()
          .setCustomId(`cx:req:${key}:net${index}`)
          .setLabel(`${amendment.action}: ${truncate(amendment.host, 50, '')}`)
          .setStyle(amendment.action === 'allow' ? ButtonStyle.Primary : ButtonStyle.Danger))));
      }
      return { embeds: [embed], components: rows };
    }

    if (method === 'item/fileChange/requestApproval') {
      const embed = new EmbedBuilder().setTitle('File change approval required').setColor(COLORS.warning)
        .addFields(
          { name: 'Reason', value: truncate(params.reason ?? '(none)', 1024) },
          { name: 'Requested root', value: `\`${truncate(params.grantRoot ?? '(current change only)', 1000)}\`` },
        )
        .setFooter({ text: `task ${record.threadId}` });
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`cx:req:${key}:accept`).setLabel('今回のみ許可').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`cx:req:${key}:acceptForSession`).setLabel('セッション中許可').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`cx:req:${key}:decline`).setLabel('拒否').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`cx:req:${key}:cancel`).setLabel('拒否して停止').setStyle(ButtonStyle.Danger),
      );
      return { embeds: [embed], components: [row] };
    }

    if (method === 'item/permissions/requestApproval') {
      const embed = new EmbedBuilder().setTitle('Additional permissions required').setColor(COLORS.warning)
        .setDescription(`\`\`\`json\n${truncate(JSON.stringify(params.permissions, null, 2), 3500).replaceAll('```', '``\\`')}\n\`\`\``)
        .addFields({ name: 'Reason', value: truncate(params.reason ?? '(none)', 1024) }, { name: 'CWD', value: `\`${truncate(params.cwd, 1000)}\`` });
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`cx:req:${key}:permTurn`).setLabel('このターンで許可').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`cx:req:${key}:permSession`).setLabel('セッション中許可').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`cx:req:${key}:permDeny`).setLabel('拒否').setStyle(ButtonStyle.Danger),
      );
      return { embeds: [embed], components: [row] };
    }

    if (method === 'item/tool/requestUserInput') {
      const questions = params.questions;
      const embed = new EmbedBuilder().setTitle('Codex needs input').setColor(COLORS.warning)
        .setDescription(questions.map((question, index) => `**${index + 1}. ${question.header}**\n${question.question}`).join('\n\n'));
      const rows = [];
      let needsModal = false;
      questions.forEach((question, index) => {
        if (question.options?.length) {
          const menu = new StringSelectMenuBuilder().setCustomId(`cx:q:${key}:${index}`).setPlaceholder(truncate(question.header, 100, ''));
          question.options.slice(0, 24).forEach((option, optionIndex) => menu.addOptions(
            new StringSelectMenuOptionBuilder().setLabel(truncate(option.label, 100, '')).setDescription(truncate(option.description, 100, '')).setValue(String(optionIndex)),
          ));
          if (question.isOther) menu.addOptions(new StringSelectMenuOptionBuilder().setLabel('自由入力').setValue('__other__'));
          rows.push(new ActionRowBuilder().addComponents(menu));
        } else {
          needsModal = true;
        }
      });
      if (needsModal) rows.push(new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`cx:req:${key}:toolModal`).setLabel('回答を入力').setStyle(ButtonStyle.Primary),
      ));
      return { embeds: [embed], components: rows.slice(0, 5) };
    }

    const embed = new EmbedBuilder().setTitle(`MCP input required: ${params.serverName}`).setColor(COLORS.warning)
      .setDescription(truncate(params.message ?? 'MCP serverから入力要求があります。', 4000));
    const row = new ActionRowBuilder();
    if (params.mode === 'url' && params.url) row.addComponents(new ButtonBuilder().setLabel('URLを開く').setURL(params.url).setStyle(ButtonStyle.Link));
    if (params.mode === 'form' || params.mode === 'openai/form') {
      row.addComponents(new ButtonBuilder().setCustomId(`cx:req:${key}:mcpForm`).setLabel('回答を入力').setStyle(ButtonStyle.Primary));
    } else {
      row.addComponents(new ButtonBuilder().setCustomId(`cx:req:${key}:mcpAccept`).setLabel('完了/許可').setStyle(ButtonStyle.Success));
    }
    row.addComponents(
      new ButtonBuilder().setCustomId(`cx:req:${key}:mcpDecline`).setLabel('拒否').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`cx:req:${key}:mcpCancel`).setLabel('キャンセル').setStyle(ButtonStyle.Danger),
    );
    return { embeds: [embed], components: [row] };
  }

  #serverRequestResult(record, action) {
    const params = record.request.params;
    if (record.method === 'item/commandExecution/requestApproval') {
      if (action === 'execPolicy') {
        return { decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: params.proposedExecpolicyAmendment } } };
      }
      if (action.startsWith('net')) {
        const index = Number.parseInt(action.slice(3), 10);
        return { decision: { applyNetworkPolicyAmendment: { network_policy_amendment: params.proposedNetworkPolicyAmendments[index] } } };
      }
      return { decision: action };
    }
    if (record.method === 'item/fileChange/requestApproval') return { decision: action };
    if (record.method === 'item/permissions/requestApproval') {
      if (action === 'permTurn') return { permissions: params.permissions, scope: 'turn', strictAutoReview: false };
      if (action === 'permSession') return { permissions: params.permissions, scope: 'session', strictAutoReview: false };
      if (action === 'permDeny') return { permissions: {}, scope: 'turn', strictAutoReview: false };
    }
    if (record.method === 'mcpServer/elicitation/request') {
      if (action === 'mcpAccept') return { action: 'accept' };
      if (action === 'mcpDecline') return { action: 'decline' };
      if (action === 'mcpCancel') return { action: 'cancel' };
    }
    throw new Error(`Unsupported request action: ${record.method}/${action}`);
  }

  async #showMcpForm(interaction, key, record) {
    const schema = record.request.params.requestedSchema ?? {};
    const properties = Object.entries(schema.properties ?? {});
    const modal = new ModalBuilder().setCustomId(`cx:input:${key}:mcp`).setTitle('MCPへの回答');
    record.modalFields = [];
    if (properties.length > 0 && properties.length <= 5) {
      properties.forEach(([name, definition], index) => {
        record.modalFields.push({ name, definition, inputId: `f${index}` });
        modal.addComponents(userInputField(`f${index}`, definition.title ?? name, {
          required: (schema.required ?? []).includes(name),
          secret: definition.format === 'password',
        }));
      });
    } else {
      record.modalFields.push({ name: '__json__', definition: { type: 'object' }, inputId: 'payload' });
      modal.addComponents(userInputField('payload', 'JSON response', { value: '{}', required: true }));
    }
    await interaction.showModal(modal);
  }

  #readMcpModal(interaction, record) {
    if (record.modalFields.length === 1 && record.modalFields[0].name === '__json__') {
      return JSON.parse(interaction.fields.getTextInputValue('payload'));
    }
    const content = {};
    for (const field of record.modalFields) {
      const raw = interaction.fields.getTextInputValue(field.inputId);
      if (!raw && !field.definition.required) continue;
      const type = Array.isArray(field.definition.type) ? field.definition.type.find((item) => item !== 'null') : field.definition.type;
      if (type === 'boolean') content[field.name] = /^(true|1|yes|y|はい)$/i.test(raw.trim());
      else if (type === 'number' || type === 'integer') {
        const numeric = Number(raw);
        if (!Number.isFinite(numeric) || (type === 'integer' && !Number.isInteger(numeric))) {
          throw new Error(`${field.name} must be a valid ${type}.`);
        }
        content[field.name] = numeric;
      }
      else if (type === 'array') content[field.name] = raw.split(',').map((value) => value.trim()).filter(Boolean);
      else content[field.name] = raw;
    }
    return content;
  }

  async #completeToolInputIfReady(record, interaction) {
    const complete = record.request.params.questions.every((question) => record.answers[question.id]);
    if (!complete) {
      await interaction.followUp(messageOptions('回答を保存しました。残りの質問にも回答してください。', { ephemeral: true }));
      return;
    }
    this.codex.respondToServerRequest(record.request.id, { answers: record.answers });
    await this.#resolvePending(record, 'Discordの選択を送信', interaction.user.id);
    await interaction.followUp(messageOptions('Codexへ回答しました。', { ephemeral: true }));
  }

  #assertPendingRequest(record) {
    if (!record) throw new Error('この要求は回答済み、または接続更新により期限切れです。');
  }

  async #resolvePending(record, note, userId) {
    this.pendingRequests.delete(record.key);
    this.#ensureControlPanel().catch((error) => {
      this.#log('control-panel-pending-update-failed', { error: error.message });
    });
    const channel = await this.client.channels.fetch(record.channelId).catch(() => null);
    const message = channel && record.messageId ? await channel.messages.fetch(record.messageId).catch(() => null) : null;
    if (message) await message.edit({ content: `Resolved: ${note}${userId ? ` by <@${userId}>` : ''}`, components: [], allowedMentions: { parse: [] } });
    this.#log('server-request-resolved', { key: record.key, method: record.method, note, userId });
  }

  async #handleConnectionState(status) {
    const state = status.state;
    if (state === this.lastConnectionState) return;
    const previous = this.lastConnectionState;
    this.lastConnectionState = state;
    if (state === 'disconnected') this.#clearPendingClientToolRequests('app-server-disconnected');
    if (this.client.user) {
      this.client.user.setPresence({
        activities: [{ name: state === 'connected' ? `${this.stateStore.bindings().length} Codex task(s)` : 'app-server reconnecting' }],
        status: state === 'connected' ? 'online' : 'idle',
      });
    }
    this.#ensureControlPanel().catch((error) => {
      this.#log('control-panel-connection-update-failed', { error: error.message });
    });
    if (previous && (state === 'connected' || state === 'disconnected')) {
      await this.#postAlert(state === 'connected'
        ? `app-serverへ再接続しました: \`${status.endpoint}\``
        : `app-server接続が切れました。自動再試行します。${status.error ? `\n${status.error}` : ''}`,
      state === 'connected' ? 'normal' : 'error');
    }
    if (state === 'connected') {
      const timer = setTimeout(() => {
        this.#syncAllTasks().catch((error) => {
          this.#log('task-sync-reconnect-error', { error: error.stack ?? error.message });
        });
      }, 2_000);
      timer.unref?.();
    }
  }

  async #handleSubscriptionRestored({ binding, thread, runtime, missedCompletion }) {
    if (this.#isBindingHidden(this.stateStore.binding(binding.threadId) ?? binding)) return;
    this.stateStore.setBinding(binding.threadId, {
      name: thread.name ?? binding.name,
      cwd: thread.cwd ?? binding.cwd,
      sessionPath: thread.path ?? binding.sessionPath,
      archived: false,
      runtimeSettings: this.#runtimeSettingsFromResume(runtime, binding.runtimeSettings),
    });
    const channel = await this.client.channels.fetch(binding.channelId).catch(() => null);
    if (!channel) return;
    const latestBinding = this.stateStore.binding(binding.threadId);
    const needsHistory = (latestBinding?.transcriptVersion ?? 0) < 11;
    const hasActiveTurn = (thread.turns ?? []).some((turn) => turn.status === 'inProgress');
    // Full transcript restoration is globally serialized to protect Discord
    // rate limits. Live-card convergence cannot wait behind that background
    // queue, especially after a Bridge restart, so repair this task's bounded
    // recent live-card set first.
    await this.#reconcileRestoredLiveTurnCards(latestBinding ?? binding, thread, channel);
    if (needsHistory) {
      await this.#reconcileThreadTranscript(binding.threadId, { channel });
    } else if (hasActiveTurn) {
      await this.#reconcileThreadTranscript(binding.threadId, { channel, activeOnly: true });
    }
    if (missedCompletion?.needsCompletionMessage && missedCompletion.turn?.id) {
      await this.#turnCompleted(
        this.stateStore.binding(binding.threadId) ?? latestBinding,
        { threadId: binding.threadId, turn: missedCompletion.turn },
      );
      return;
    }
    if (missedCompletion?.turn?.id) {
      await this.#repostTaskPanelAfterCompletion(binding.threadId, missedCompletion.turn.id, channel).catch((error) => {
        this.#log('task-panel-restored-completion-repost-failed', {
          threadId: binding.threadId,
          turnId: missedCompletion.turn.id,
          error: error.stack ?? error.message,
        });
      });
    }
    if (!missedCompletion?.needsCompletionNotice) return;

    const { turn } = missedCompletion;
    if (this.stateStore.binding(binding.threadId)?.completionReportsEnabled === false) {
      this.#log('missed-completion-notice-suppressed', {
        threadId: binding.threadId,
        turnId: turn.id,
      });
      this.stateStore.setBinding(binding.threadId, { lastNotifiedCompletedTurnId: turn.id });
      return;
    }
    const record = this.stateStore.turnRecord(binding.threadId, turn.id);
    const completionMessage = record?.finalMessageIds?.[0]
      ? await channel.messages.fetch(record.finalMessageIds[0]).catch(() => null)
      : null;
    if (!completionMessage) return;
    const finalText = missedCompletion.finalText || turn.error?.message || '(textなし)';
    const notice = await this.#postCompletionNotice(completionMessage, finalText, binding.threadId, turn.id);
    if (!notice) {
      this.#log('missed-completion-notice-suppressed', {
        threadId: binding.threadId,
        turnId: turn.id,
      });
    }
    this.stateStore.setBinding(binding.threadId, { lastNotifiedCompletedTurnId: turn.id });
  }

  #userMessagesFromThread(thread) {
    const messages = [];
    for (const turn of thread.turns ?? []) {
      for (const item of turn.items ?? []) {
        if (item.type !== 'userMessage') continue;
        const text = (item.content ?? []).map((part) => part.text ?? '').filter(Boolean).join('\n');
        if (text) messages.push({ id: item.id ?? null, text });
      }
    }
    return messages;
  }

  async #postTaskMessage(binding, content) {
    const channel = await this.client.channels.fetch(binding.channelId).catch(() => null);
    if (channel) await channel.send(messageOptions(content));
  }

  #reserveUserInput(threadId, text, source, {
    executorUserId = null,
    alreadyVisible = false,
    visibleMessageId = null,
  } = {}) {
    this.#pruneUserInputReservations();
    const record = {
      threadId,
      text: String(text).trim(),
      source,
      executorUserId,
      state: 'pending',
      echoSeen: false,
      postPromise: null,
      alreadyVisible,
      visibleMessageId,
      turnId: null,
      userItemId: null,
      clientUserMessageId: `discord-${randomKey()}`,
      postedItemId: null,
      at: Date.now(),
    };
    this.recentUserInputs.push(record);
    return record;
  }

  #removeUserInputReservation(record) {
    const index = this.recentUserInputs.indexOf(record);
    if (index >= 0) this.recentUserInputs.splice(index, 1);
  }

  #claimUserInputReservation(threadId, text, clientUserMessageId = null) {
    this.#pruneUserInputReservations();
    const record = this.recentUserInputs.find((candidate) => candidate.threadId === threadId
      && !candidate.echoSeen
      && (
        (clientUserMessageId && candidate.clientUserMessageId === clientUserMessageId)
        || candidate.text === String(text).trim()
      ));
    if (record) record.echoSeen = true;
    return record ?? null;
  }

  async #ensureReservedUserInputPosted(record) {
    if (!record.postPromise) {
      record.state = 'posting';
      record.postPromise = this.#waitForReservationTurnId(record)
        .then(async () => {
          if (!record.turnId) throw new Error('Codex did not return a turn ID for the user input.');
          if (record.executorUserId) {
            const turnRecord = this.stateStore.turnRecord(record.threadId, record.turnId) ?? {};
            this.stateStore.setTurnRecord(record.threadId, record.turnId, {
              executorUserIds: [...new Set([
                ...(turnRecord.executorUserIds ?? []),
                turnRecord.executorUserId,
                record.executorUserId,
              ].filter(Boolean))],
            });
          }
          const itemId = record.userItemId ?? record.clientUserMessageId;
          if (!record.userItemId) {
            this.#log('user-input-provisional-id', {
              threadId: record.threadId,
              turnId: record.turnId,
              clientUserMessageId: record.clientUserMessageId,
            });
          }
          const mirrored = await this.#postUserInput(
            record.threadId,
            record.turnId,
            itemId,
            record.text,
            record.source,
            record.visibleMessageId,
          );
          record.postedItemId = itemId;
          if (record.userItemId && record.userItemId !== record.postedItemId) {
            await this.#postUserInput(
              record.threadId,
              record.turnId,
              record.userItemId,
              record.text,
              record.source,
            );
            record.postedItemId = record.userItemId;
          }
          return mirrored;
        })
        .then((mirrored) => {
          record.state = 'posted';
          record.at = Date.now();
          return mirrored;
        })
        .catch((error) => {
          record.state = 'failed';
          record.postPromise = null;
          throw error;
        });
    }
    return record.postPromise;
  }

  async #moveLiveCardAfterReservedInput(record) {
    if (!record.turnId) return;
    if (!record.liveCardMovePromise) {
      record.liveCardMovePromise = (async () => {
        const binding = this.stateStore.binding(record.threadId);
        if (!binding) return;
        const view = this.#view(record.threadId, record.turnId, binding.channelId);
        view.status = 'inProgress';
        await this.#moveLiveTurnCardToLatest(binding, view);
      })().catch((error) => {
        record.liveCardMovePromise = null;
        throw error;
      });
    }
    return record.liveCardMovePromise;
  }

  async #waitForReservationTurnId(record) {
    for (let attempt = 0;
      attempt < 100 && !record.turnId;
      attempt += 1) {
      await sleep(50);
    }
  }

  #pruneUserInputReservations() {
    const cutoff = Date.now() - 120_000;
    this.recentUserInputs = this.recentUserInputs.filter((record) => record.at >= cutoff);
  }

  async #postUserInput(threadId, turnId, userItemId, text, source, sourceMessageId = null) {
    const binding = this.stateStore.binding(threadId);
    if (!binding) return false;
    const channel = await this.client.channels.fetch(binding.channelId).catch(() => null);
    if (!channel) throw new Error(`Discord task channel is unavailable: ${binding.channelId}`);
    const value = String(text).trim() || '(empty)';
    const itemId = userItemId ?? `input-${turnId}`;
    const turn = {
      id: turnId,
      status: 'inProgress',
      items: [{ type: 'userMessage', id: itemId, content: [{ type: 'text', text: value }] }],
    };
    if (sourceMessageId) {
      const current = this.stateStore.turnRecord(threadId, turnId) ?? {};
      const userEntries = { ...(current.userEntries ?? {}) };
      userEntries[itemId] = { text: value, messageIds: [sourceMessageId], source };
      this.stateStore.setTurnRecord(threadId, turnId, {
        userEntries,
        userMessageIds: [...new Set(Object.values(userEntries).flatMap((entry) => entry.messageIds ?? []))],
      });
    }
    const messages = await this.#fetchChannelHistory(channel, 100);
    const ids = await this.#ensureTurnUserMessages(binding, turn, channel, messages);
    if (ids.length) {
      const record = this.stateStore.turnRecord(threadId, turnId) ?? {};
      const userEntries = { ...(record.userEntries ?? {}) };
      userEntries[itemId] = { ...userEntries[itemId], source };
      this.stateStore.setTurnRecord(threadId, turnId, { userEntries });
    }
    return ids.length > 0;
  }

  async #postAlert(content, kind = 'normal') {
    await this.infrastructureReady?.catch(() => {});
    const channelId = this.stateStore.snapshot().infrastructure.alertsChannelId;
    if (!channelId) return;
    const channel = await this.client.channels.fetch(channelId).catch(() => null);
    if (!channel) return;
    const embed = new EmbedBuilder()
      .setTitle(kind === 'error' ? 'Codex Remote alert' : 'Codex Remote')
      .setColor(kind === 'error' ? COLORS.error : COLORS.neutral)
      .setDescription(truncate(content, 4000))
      .setTimestamp();
    await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
  }

  #log(event, details) {
    appendJsonLine(this.logPath, event, details);
  }
}
