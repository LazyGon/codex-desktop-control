import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  PermissionFlagsBits,
} from 'discord.js';
import { IncomingAttachmentStore } from './incoming-attachment-store.mjs';
import {
  CHATGPT_COLOR,
  CHATGPT_CONTROL_PANEL_MARKER,
  chatgptControlPanelPayload,
  chatgptConversationPanelMarker,
  chatgptConversationPanelPayload,
} from './chatgpt-panels.mjs';
import { safeAttachmentName } from './local-file-share.mjs';
import {
  createSplit7zArchive,
  disposeSplitArchive,
  readArchiveVolume,
  splitArchiveManifest,
} from './split-archive.mjs';
import {
  appendJsonLine,
  sanitizeChannelName,
  splitText,
  truncate,
} from './util.mjs';

const ERROR_COLOR = 0xc92a2a;
const WARNING_COLOR = 0xf0b232;
const RESPONSE_CHUNK_LENGTH = 1_800;
const MAX_RESPONSE_POSTS = 10;
const RETURNED_FILE_MATERIALIZATION_KIND = 'reviewer-accessor.discord-returned-file-materialization';
const DISCORD_INLINE_IMAGE_EXTENSIONS = new Set(['.gif', '.jpeg', '.jpg', '.png', '.webp']);
const ATTACHMENT_ONLY_PROMPT = [
  '添付ファイルがユーザーからの依頼です。',
  '内容を読み取り、意図を判断して、可能な分析・回答・作業を進めてください。',
  '単なる確認だけで終わらず、意図を確定できない場合だけ質問してください。',
].join('');

function messageOptions(content, extra = {}) {
  return { content, allowedMentions: { parse: [] }, ...extra };
}

export function splitChatgptMarkdown(value, maximum = RESPONSE_CHUNK_LENGTH) {
  const input = String(value ?? '').trim() || '(応答本文なし)';
  const rawChunks = splitText(input, Math.max(200, maximum - 80));
  let openFence = null;
  return rawChunks.map((chunk) => {
    const prefix = openFence === null ? '' : `\`\`\`${openFence}\n`;
    for (const match of chunk.matchAll(/^\s*\`\`\`([^\s\`]*)/gm)) {
      openFence = openFence === null ? String(match[1] ?? '').slice(0, 32) : null;
    }
    const suffix = openFence === null ? '' : '\n```';
    return `${prefix}${chunk}${suffix}`;
  });
}

function safeAttachmentLabel(value) {
  return String(value ?? 'unnamed-file').replaceAll('`', '\\`');
}

function formatFileSize(value) {
  const size = Number(value);
  if (!Number.isFinite(size) || size < 0) return 'unknown size';
  if (size < 1_000) return `${size} B`;
  if (size < 1_000_000) return `${(size / 1_000).toFixed(1)} KB`;
  if (size < 1_000_000_000) return `${(size / 1_000_000).toFixed(1)} MB`;
  return `${(size / 1_000_000_000).toFixed(1)} GB`;
}

function containedReturnedFilePath(outputRoot, candidate) {
  if (typeof outputRoot !== 'string' || typeof candidate !== 'string'
    || !path.isAbsolute(outputRoot) || !path.isAbsolute(candidate)) return null;
  const resolvedRoot = path.resolve(outputRoot);
  const resolvedCandidate = path.resolve(candidate);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  return resolvedCandidate;
}

async function sha256File(filePath) {
  const hash = createHash('sha256');
  const stream = fs.createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest('hex');
}

function returnedFileName(entry, index, usedNames) {
  const descriptorName = entry?.descriptor?.name;
  const materializedPath = entry?.materialization?.path;
  const base = safeAttachmentName(path.basename(String(descriptorName || materializedPath || `chatgpt-file-${index + 1}`)))
    || `chatgpt-file-${index + 1}`;
  let candidate = base;
  const extension = path.extname(base);
  const stem = extension ? base.slice(0, -extension.length) : base;
  for (let suffix = 2; usedNames.has(candidate.toLocaleLowerCase('en-US')); suffix += 1) {
    candidate = safeAttachmentName(`${stem}-${suffix}${extension}`);
  }
  usedNames.add(candidate.toLocaleLowerCase('en-US'));
  return candidate;
}

function isInlineReturnedImage(name, contentType) {
  return String(contentType ?? '').toLowerCase().startsWith('image/')
    && DISCORD_INLINE_IMAGE_EXTENSIONS.has(path.extname(name).toLocaleLowerCase('en-US'));
}

function returnedFilesUnavailablePayload(entries) {
  const lines = entries.slice(0, 25).map(({ name, code }) => `- \`${safeAttachmentLabel(name)}\` — \`${code}\``);
  if (entries.length > lines.length) lines.push(`- ほか ${entries.length - lines.length} 件`);
  return {
    embeds: [new EmbedBuilder()
      .setTitle(`ChatGPT files unavailable (${entries.length})`)
      .setColor(WARNING_COLOR)
      .setDescription(truncate([
        '取得またはDiscord転送できなかった返却物です。回答本文と他の返却物は保持しています。',
        '',
        ...lines,
      ].join('\n'), 4_000, '…'))],
    allowedMentions: { parse: [] },
  };
}

export async function chatgptReturnedFilePayloads(materialization, {
  expectedOutputRoot,
  directFileBytes = 7_500_000,
  maxFileBytes = 512_000_000,
  archiveTempRoot = null,
  archiverPath = null,
} = {}) {
  if (!materialization) return {
    payloads: [],
    readyCount: 0,
    unavailableCount: 0,
    cleanupAllowed: true,
  };
  const payloads = [];
  const unavailable = [];
  let readyCount = 0;
  let retainOutputRoot = false;
  const expectedRoot = path.resolve(String(expectedOutputRoot ?? ''));
  const actualRoot = typeof materialization.outputRoot === 'string'
    ? path.resolve(materialization.outputRoot)
    : null;
  const structurallyValid = materialization.schemaVersion === 1
    && materialization.kind === RETURNED_FILE_MATERIALIZATION_KIND
    && ['COMPLETE', 'PARTIAL'].includes(materialization.status)
    && materialization.cleanupOwner === 'caller'
    && path.isAbsolute(String(expectedOutputRoot ?? ''))
    && actualRoot === expectedRoot
    && Array.isArray(materialization.files);
  if (!structurallyValid) {
    return {
      payloads: [returnedFilesUnavailablePayload([{
        name: 'returned-file materialization',
        code: 'BRIDGE_MATERIALIZATION_INVALID',
      }])],
      readyCount: 0,
      unavailableCount: 1,
      cleanupAllowed: false,
    };
  }

  const usedNames = new Set();
  for (const [index, entry] of materialization.files.entries()) {
    const name = returnedFileName(entry, index, usedNames);
    const file = entry?.materialization;
    if (file?.status === 'UNAVAILABLE') {
      unavailable.push({ name, code: file.code || 'RETURNED_FILE_UNAVAILABLE' });
      continue;
    }
    const containedPath = file?.status === 'READY'
      ? containedReturnedFilePath(expectedRoot, file.path)
      : null;
    const declaredHash = String(file?.sha256 ?? '').toLowerCase();
    const stat = containedPath
      ? await fs.promises.lstat(containedPath).catch(() => null)
      : null;
    if (!containedPath || !stat?.isFile() || stat.isSymbolicLink()
      || !Number.isSafeInteger(file.sizeBytes) || file.sizeBytes < 0
      || stat.size !== file.sizeBytes || !/^[a-f0-9]{64}$/.test(declaredHash)) {
      unavailable.push({ name, code: 'BRIDGE_RETURNED_FILE_INVALID' });
      retainOutputRoot = true;
      continue;
    }
    const actualHash = await sha256File(containedPath).catch(() => null);
    if (actualHash !== declaredHash) {
      unavailable.push({ name, code: 'BRIDGE_RETURNED_FILE_HASH_MISMATCH' });
      retainOutputRoot = true;
      continue;
    }
    if (stat.size <= directFileBytes) {
      const inlineImage = isInlineReturnedImage(name, file.contentType);
      payloads.push({
        content: [
          inlineImage ? '**ChatGPT image**' : '**ChatGPT file**',
          `\`${safeAttachmentLabel(name)}\` · ${formatFileSize(stat.size)}`,
        ].join('\n'),
        files: [new AttachmentBuilder(containedPath, { name })],
        allowedMentions: { parse: [] },
      });
      readyCount += 1;
      continue;
    }
    if (stat.size > maxFileBytes || !archiveTempRoot) {
      unavailable.push({ name, code: 'BRIDGE_RETURNED_FILE_TRANSFER_LIMIT' });
      retainOutputRoot = true;
      continue;
    }
    let archive = null;
    try {
      archive = await createSplit7zArchive({
        path: containedPath,
        root: expectedRoot,
        relativePath: name,
        name,
        size: stat.size,
        mtime: stat.mtime.toISOString(),
      }, {
        volumeBytes: directFileBytes,
        maxBytes: maxFileBytes,
        tempRoot: archiveTempRoot,
        archiverPath,
      });
      if (archive.original.sha256 !== declaredHash) {
        throw new Error('Returned file changed before archive creation.');
      }
      payloads.push({
        content: [
          '**ChatGPT file archive**',
          `\`${safeAttachmentLabel(name)}\` · ${formatFileSize(stat.size)}`,
          `7z · ${archive.volumes.length} volume(s) · SHA-256 \`${declaredHash}\``,
          `全volumeを同じフォルダへ保存し、\`${archive.volumes[0].name}\`を7z対応アプリで開いてください。`,
        ].join('\n'),
        allowedMentions: { parse: [] },
      });
      for (const volume of archive.volumes) {
        payloads.push({
          content: `**${archive.archiveName}** volume ${volume.index + 1}/${archive.volumes.length}`,
          files: [new AttachmentBuilder(await readArchiveVolume(volume), { name: volume.name })],
          allowedMentions: { parse: [] },
        });
      }
      const manifest = Buffer.from(`${JSON.stringify(splitArchiveManifest(archive), null, 2)}\n`, 'utf8');
      payloads.push({
        content: `**${archive.archiveName}** transfer manifest`,
        files: [new AttachmentBuilder(manifest, { name: safeAttachmentName(name, '.7z-manifest.json') })],
        allowedMentions: { parse: [] },
      });
      readyCount += 1;
    } catch {
      unavailable.push({ name, code: 'BRIDGE_RETURNED_FILE_ARCHIVE_FAILED' });
      retainOutputRoot = true;
    } finally {
      if (archive) await disposeSplitArchive(archive).catch(() => {});
    }
  }
  if (unavailable.length > 0) payloads.push(returnedFilesUnavailablePayload(unavailable));
  return {
    payloads,
    readyCount,
    unavailableCount: unavailable.length,
    cleanupAllowed: !retainOutputRoot,
  };
}

export function chatgptResponsePayloads(text, {
  assistantAttachments = [],
  returnedFileMaterialization = null,
} = {}) {
  const completeText = String(text ?? '').trim() || '(応答本文なし)';
  const chunks = splitChatgptMarkdown(completeText);
  const payloads = [];
  const previewCount = chunks.length > MAX_RESPONSE_POSTS ? MAX_RESPONSE_POSTS - 1 : chunks.length;
  for (let index = 0; index < previewCount; index += 1) {
    const page = chunks.length === 1 ? '**ChatGPT**' : `**ChatGPT · ${index + 1}/${chunks.length}**`;
    payloads.push({
      content: `${page}\n${chunks[index]}`,
      allowedMentions: { parse: [] },
    });
  }
  if (chunks.length > MAX_RESPONSE_POSTS) {
    payloads.push({
      content: `**ChatGPT · 完全版**\n回答が長いため、完全なMarkdown本文を添付しました（${completeText.length}文字）。`,
      files: [new AttachmentBuilder(Buffer.from(completeText, 'utf8'), { name: 'chatgpt-answer.md' })],
      allowedMentions: { parse: [] },
    });
  }
  if (!returnedFileMaterialization && assistantAttachments.length > 0) {
    const lines = assistantAttachments.slice(0, 25).map((attachment) => {
      const name = safeAttachmentLabel(attachment?.name ?? attachment?.fileName ?? attachment?.id);
      const details = [
        attachment?.mimeType,
        Number.isFinite(attachment?.size) ? `${attachment.size} bytes` : null,
      ].filter(Boolean).join(' · ');
      return `- \`${name}\`${details ? ` — ${details}` : ''}`;
    });
    if (assistantAttachments.length > lines.length) {
      lines.push(`- ほか ${assistantAttachments.length - lines.length} 件`);
    }
    payloads.push({
      embeds: [new EmbedBuilder()
        .setTitle(`ChatGPT returned files (${assistantAttachments.length})`)
        .setColor(CHATGPT_COLOR)
        .setDescription(truncate([
          ...lines,
          '',
          '返却ファイルの実体化結果がないため、descriptorだけを表示しています。',
        ].join('\n'), 4_000, '…'))],
      allowedMentions: { parse: [] },
    });
  }
  return payloads;
}

function historyAttachmentSummary(attachments = []) {
  if (!Array.isArray(attachments) || attachments.length === 0) return '';
  const lines = attachments.slice(0, 5).map((attachment) => {
    const name = safeAttachmentLabel(truncate(attachment?.name ?? attachment?.id ?? 'unnamed-file', 120, '…'));
    const details = [
      attachment?.mimeType,
      Number.isFinite(attachment?.size) ? formatFileSize(attachment.size) : null,
    ].filter(Boolean).join(' · ');
    return `- \`${name}\`${details ? ` — ${details}` : ''}`;
  });
  if (attachments.length > lines.length) lines.push(`- ほか ${attachments.length - lines.length} 件`);
  return `\n\n添付情報:\n${lines.join('\n')}`;
}

function historyTextPayload(label, text, {
  attachments = [],
  completeFileName,
  note = null,
} = {}) {
  const exactText = String(text ?? '');
  const attachmentSummary = historyAttachmentSummary(attachments);
  const header = `**${label}**`;
  const noteText = note ? `\n${note}` : '';
  const maximumBody = Math.max(200, 1_950 - header.length - noteText.length - attachmentSummary.length);
  const displayText = exactText || (note ? '' : '(本文なし)');
  const truncated = displayText.length > maximumBody;
  const preview = truncated
    ? truncate(displayText, Math.max(100, maximumBody - 45), '…')
    : displayText;
  const payload = {
    content: `${header}${noteText}${preview ? `\n${preview}` : ''}${attachmentSummary}${truncated ? '\n\n全文は添付Markdownを参照してください。' : ''}`,
    allowedMentions: { parse: [] },
  };
  if (truncated) {
    payload.files = [new AttachmentBuilder(Buffer.from(exactText, 'utf8'), { name: completeFileName })];
  }
  return payload;
}

export function chatgptHistoryTurnPayloads(turn) {
  const turnId = String(turn?.turnId ?? 'unknown');
  const suffix = turnId.slice(-12).replace(/[^a-z0-9-]/gi, '_');
  const user = historyTextPayload('You · synced history', turn?.user?.text, {
    attachments: turn?.user?.attachments ?? [],
    completeFileName: `chatgpt-history-user-${suffix}.md`,
  });
  if (turn?.status === 'COMPLETED' && turn.assistantFinal) {
    return [user, historyTextPayload('ChatGPT · synced history', turn.assistantFinal.text, {
      attachments: turn.assistantFinal.attachments ?? [],
      completeFileName: `chatgpt-history-assistant-${suffix}.md`,
    })];
  }
  const reason = turn?.incompleteReason === 'DURABLE_FINAL_AMBIGUOUS'
    ? '確定済みの最終回答を一つに特定できません。'
    : '確定済みの最終回答はまだありません。';
  return [user, historyTextPayload('ChatGPT · synced history · incomplete', '', {
    completeFileName: `chatgpt-history-assistant-${suffix}.md`,
    note: reason,
  })];
}

export function chatgptLiveRecordForHistoryTurn(conversation, turn) {
  const records = Object.entries(conversation?.messageRecords ?? {});
  return records.find(([, record]) => record.state === 'completed' && (
    (turn?.user?.messageId && record.requestMessageId === turn.user.messageId)
    || (turn?.assistantFinal?.messageId && record.assistantMessageId === turn.assistantFinal.messageId)
  )) ?? null;
}

export function isUnsupportedChatgptImage(attachment) {
  if (String(attachment?.contentType ?? '').toLowerCase().startsWith('image/')) return true;
  return /\.(?:avif|bmp|gif|heic|heif|jpe?g|png|svg|tiff?|webp)$/i.test(String(attachment?.name ?? ''));
}

function channelName(conversation, active = false) {
  return `${active ? '🟢' : '⚫'}-${sanitizeChannelName(conversation.name || `chatgpt-${conversation.conversationId.slice(-8)}`, 'chatgpt')}`;
}

function interactionMarker(message) {
  return message?.embeds?.map((embed) => embed.footer?.text).find(Boolean) ?? null;
}

export class ChatgptController {
  constructor({ client, service, stateStore, config, logDir, incomingAttachmentStore = null }) {
    this.client = client;
    this.service = service;
    this.stateStore = stateStore;
    this.config = config;
    this.authorizedUserIds = [...new Set(config.authorizedUserIds ?? [])];
    this.logPath = path.join(logDir, `chatgpt-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}.jsonl`);
    this.returnedFileRoot = path.join(path.dirname(logDir), 'data', 'chatgpt-returned-files');
    this.returnedArchiveRoot = path.join(path.dirname(logDir), 'data', 'chatgpt-returned-archives');
    this.incomingAttachmentStore = incomingAttachmentStore ?? new IncomingAttachmentStore(
      path.join(path.dirname(logDir), 'data', 'incoming-files'),
      {
        maxFileBytes: config.inputAttachmentMaxBytes,
        maxTotalBytes: config.inputAttachmentTotalMaxBytes,
        maxCount: config.inputAttachmentMaxCount,
        timeoutMs: config.discordRestTimeoutMs,
      },
    );
    this.infrastructure = null;
    this.queues = new Map();
    this.renderTimers = new Set();
    this.stopping = false;
    this.readyState = false;
    this.readyError = null;
  }

  attach() {
    this.client.on('interactionCreate', (interaction) => {
      this.#handleInteraction(interaction).catch((error) => this.#interactionError(interaction, error));
    });
    this.client.on('messageCreate', (message) => this.#queueMessage(message));
  }

  status() {
    return {
      enabled: Boolean(this.config.chatgptEnabled),
      ready: this.readyState,
      error: this.readyError?.message ?? null,
      linkedConversations: this.stateStore.chatgptConversations().length,
      activeConversations: this.service.activeCount,
      activeHistorySyncs: this.service.activeHistoryCount ?? 0,
      categoryId: this.infrastructure?.category?.id ?? null,
      controlChannelId: this.infrastructure?.control?.id ?? null,
    };
  }

  async ready() {
    if (!this.config.chatgptEnabled) return;
    this.infrastructure = await this.#ensureInfrastructure();
    try {
      await this.service.status();
      this.readyState = true;
      this.readyError = null;
    } catch (error) {
      this.readyState = false;
      this.readyError = error;
      this.#log('service-ready-failed', { error: error.stack ?? error.message });
    }
    await this.#recoverInterruptedMessages();
    await this.#ensureAllConversationChannels();
    await this.#refreshControlPanel();
    this.#log('ready', {
      ready: this.readyState,
      conversations: this.stateStore.chatgptConversations().length,
      categoryId: this.infrastructure.category.id,
      controlChannelId: this.infrastructure.control.id,
    });
  }

  async stop() {
    this.stopping = true;
    for (const timer of this.renderTimers) clearTimeout(timer);
    this.renderTimers.clear();
    const serviceStop = this.service.stop(300_000);
    const queued = Promise.allSettled([...this.queues.values()]);
    return Promise.allSettled([serviceStop, queued]);
  }

  async #ensureInfrastructure() {
    const guild = await this.client.guilds.fetch(this.config.guildId);
    const channels = await guild.channels.fetch();
    const infrastructure = this.stateStore.infrastructure();
    const controlCategory = channels.get(infrastructure.controlCategoryId);
    if (!controlCategory || controlCategory.type !== ChannelType.GuildCategory) {
      throw new Error('Codex Controlカテゴリが未初期化です。');
    }
    const controlOverwrites = controlCategory.permissionOverwrites?.cache
      ? [...controlCategory.permissionOverwrites.cache.values()].map((overwrite) => ({
        id: overwrite.id,
        type: overwrite.type,
        allow: overwrite.allow.bitfield,
        deny: overwrite.deny.bitfield,
      }))
      : [];
    if (controlOverwrites.length === 0) {
      throw new Error('Codex Controlカテゴリの非公開権限をChatGPTカテゴリへ複製できません。');
    }

    let category = infrastructure.chatgptCategoryId
      ? channels.get(infrastructure.chatgptCategoryId)
      : null;
    if (!category || category.type !== ChannelType.GuildCategory) {
      category = channels.find((candidate) => candidate?.type === ChannelType.GuildCategory
        && candidate.name === this.config.chatgptCategoryName);
    }
    if (!category) {
      category = await guild.channels.create({
        name: this.config.chatgptCategoryName,
        type: ChannelType.GuildCategory,
        permissionOverwrites: controlOverwrites,
      });
    }
    const everyoneOverwrite = category.permissionOverwrites?.cache?.get(guild.roles.everyone.id);
    if (!everyoneOverwrite?.deny?.has?.(PermissionFlagsBits.ViewChannel)) {
      await category.permissionOverwrites.set(
        controlOverwrites,
        'Restore private permissions for linked ChatGPT conversations',
      );
    }
    if (category.name !== this.config.chatgptCategoryName) {
      await category.setName(this.config.chatgptCategoryName, 'Refresh ChatGPT Remote category name');
    }

    let control = infrastructure.chatgptControlChannelId
      ? channels.get(infrastructure.chatgptControlChannelId)
      : null;
    if (!control || control.type !== ChannelType.GuildText) {
      control = channels.find((candidate) => candidate?.type === ChannelType.GuildText
        && candidate.parentId === controlCategory.id
        && candidate.name === this.config.chatgptControlChannelName);
    }
    if (!control) {
      control = await guild.channels.create({
        name: this.config.chatgptControlChannelName,
        type: ChannelType.GuildText,
        parent: controlCategory.id,
        topic: 'Explicit ChatGPT conversation links through reviewer-accessor',
      });
    }
    if (control.parentId !== controlCategory.id) {
      await control.setParent(controlCategory.id, { lockPermissions: true, reason: 'Restore ChatGPT control channel' });
    }
    if (!control.permissionsLocked) await control.lockPermissions();
    this.stateStore.setInfrastructure({
      chatgptCategoryId: category.id,
      chatgptControlChannelId: control.id,
    });
    return { guild, controlCategory, category, control };
  }

  async #ensureAllConversationChannels() {
    for (const conversation of this.stateStore.chatgptConversations()) {
      await this.#ensureConversationChannel(conversation);
    }
  }

  async #ensureConversationChannel(conversation) {
    const { guild, category } = this.infrastructure;
    let channel = conversation.channelId
      ? await this.client.channels.fetch(conversation.channelId).catch(() => null)
      : null;
    if (!channel || channel.type !== ChannelType.GuildText) {
      channel = await guild.channels.create({
        name: channelName(conversation, Boolean(conversation.activeMessageId)),
        type: ChannelType.GuildText,
        parent: category.id,
        topic: `ChatGPT conversation: ${conversation.conversationId} | reviewer-accessor`,
      });
    }
    if (channel.parentId !== category.id) {
      await channel.setParent(category.id, { lockPermissions: true, reason: 'List linked ChatGPT conversations in the managed category' });
    }
    if (!channel.permissionsLocked) await channel.lockPermissions();
    const desiredName = channelName(conversation, Boolean(conversation.activeMessageId));
    if (channel.name !== desiredName) await channel.setName(desiredName, 'Refresh ChatGPT conversation state');
    this.stateStore.setChatgptConversation(conversation.conversationId, { channelId: channel.id });
    await this.#ensureConversationPanel(this.stateStore.chatgptConversation(conversation.conversationId), channel);
    return channel;
  }

  async #linkConversation({ conversationUrl, name, responsePerformance }) {
    const identity = await this.service.identity(conversationUrl);
    const existing = this.stateStore.chatgptConversation(identity.conversationId);
    this.stateStore.setChatgptConversation(identity.conversationId, {
      conversationUrl: identity.conversationUrl,
      name: String(name ?? '').trim() || existing?.name || `ChatGPT ${identity.conversationId.slice(-8)}`,
      responsePerformance: responsePerformance
        || existing?.responsePerformance
        || this.config.reviewerAccessorResponsePerformance,
      linkedAt: existing?.linkedAt ?? new Date().toISOString(),
      activeMessageId: existing?.activeMessageId ?? null,
      controlPanelMessageId: existing?.controlPanelMessageId ?? null,
    });
    const conversation = this.stateStore.chatgptConversation(identity.conversationId);
    const channel = await this.#ensureConversationChannel(conversation);
    await this.#refreshControlPanel();
    this.#log('conversation-linked', {
      conversationId: identity.conversationId,
      channelId: channel.id,
      name: conversation.name,
      responsePerformance: conversation.responsePerformance,
    });
    return { conversation: this.stateStore.chatgptConversation(identity.conversationId), channel };
  }

  #queueMessage(message) {
    if (!this.config.chatgptEnabled || this.stopping) return;
    if (message.guildId !== this.config.guildId || message.author?.bot || message.webhookId) return;
    const conversation = this.stateStore.chatgptConversationByChannel(message.channelId);
    if (!conversation) return;
    const content = String(message.content ?? '').trim();
    const attachments = [...(message.attachments?.values?.() ?? [])];
    if (!content && attachments.length === 0) return;
    if (this.stateStore.chatgptMessageRecord(conversation.conversationId, message.id)) return;
    this.stateStore.setChatgptMessageRecord(conversation.conversationId, message.id, {
      state: 'queued',
      userId: message.author.id,
      channelId: message.channelId,
      createdAt: new Date().toISOString(),
    });
    const previous = this.queues.get(message.channelId) ?? Promise.resolve();
    const queued = previous.catch(() => {}).then(() => this.#handleMessage(message, conversation.conversationId));
    this.queues.set(message.channelId, queued);
    queued.catch((error) => this.#log('message-failed', {
      conversationId: conversation.conversationId,
      messageId: message.id,
      error: error.stack ?? error.message,
    })).finally(() => {
      if (this.queues.get(message.channelId) === queued) this.queues.delete(message.channelId);
    });
  }

  async #handleMessage(message, conversationId) {
    const conversation = this.stateStore.chatgptConversation(conversationId);
    if (!conversation) return;
    if (!this.#canExecuteMessage(message)) {
      this.stateStore.setChatgptMessageRecord(conversationId, message.id, { state: 'rejected' });
      await message.reply(messageOptions('拒否しました。このChatGPTチャンネルの表示・送信権限が必要です。')).catch(() => {});
      return;
    }
    const attachments = [...(message.attachments?.values?.() ?? [])];
    const unsupported = attachments.find(isUnsupportedChatgptImage);
    if (unsupported) {
      this.stateStore.setChatgptMessageRecord(conversationId, message.id, { state: 'failed', submitted: false });
      await message.react('❌').catch(() => {});
      await message.reply(messageOptions(
        `reviewer-accessorの現行契約では画像入力を送れません: ${truncate(unsupported.name, 300)}`,
      )).catch(() => {});
      return;
    }

    await message.react('⏳').catch(() => {});
    let liveMessage = null;
    let renderTimer = null;
    let latestText = '';
    const returnedFileOutputRoot = path.join(
      this.returnedFileRoot,
      String(conversationId).replace(/[^a-z0-9-]/gi, '_'),
      String(message.id).replace(/[^a-z0-9-]/gi, '_'),
      randomUUID(),
    );
    try {
      const storedAttachments = attachments.length > 0
        ? await this.incomingAttachmentStore.store({
          threadId: `chatgpt-${conversationId}`,
          sourceId: message.id,
          attachments,
        })
        : [];
      liveMessage = await message.channel.send({
        embeds: [new EmbedBuilder()
          .setTitle('ChatGPT responding')
          .setColor(CHATGPT_COLOR)
          .setDescription('応答を待っています…')],
        allowedMentions: { parse: [] },
      });
      this.stateStore.setChatgptMessageRecord(conversationId, message.id, {
        state: 'dispatching',
        submitted: null,
        liveMessageId: liveMessage.id,
        attachmentCount: storedAttachments.length,
        returnedFileOutputRoot,
      });
      this.stateStore.setChatgptConversation(conversationId, { activeMessageId: message.id });
      await this.#setConversationActive(conversationId, true);
      await this.#refreshControlPanel();

      const scheduleRender = () => {
        if (renderTimer || !liveMessage) return;
        renderTimer = setTimeout(() => {
          this.renderTimers.delete(renderTimer);
          renderTimer = null;
          liveMessage.edit({
            embeds: [new EmbedBuilder()
              .setTitle('ChatGPT responding')
              .setColor(CHATGPT_COLOR)
              .setDescription(truncate(latestText || '応答を待っています…', RESPONSE_CHUNK_LENGTH, '…'))],
            allowedMentions: { parse: [] },
          }).catch((error) => this.#log('live-render-failed', { messageId: liveMessage.id, error: error.message }));
        }, this.config.chatgptLiveUpdateIntervalMs);
        this.renderTimers.add(renderTimer);
      };

      const result = await this.service.send({
        conversationUrl: conversation.conversationUrl,
        responsePerformance: conversation.responsePerformance,
        prompt: String(message.content ?? '').trim() || ATTACHMENT_ONLY_PROMPT,
        files: storedAttachments.map((attachment) => attachment.path),
        returnedFileOutputRoot,
        onText: (text) => {
          latestText = String(text ?? '');
          scheduleRender();
        },
      });
      if (renderTimer) {
        clearTimeout(renderTimer);
        this.renderTimers.delete(renderTimer);
        renderTimer = null;
      }
      const payloads = chatgptResponsePayloads(result.assistantText, {
        assistantAttachments: result.assistantAttachments ?? [],
        returnedFileMaterialization: result.returnedFileMaterialization ?? null,
      });
      const returnedFiles = await chatgptReturnedFilePayloads(result.returnedFileMaterialization, {
        expectedOutputRoot: returnedFileOutputRoot,
        directFileBytes: this.config.fileShareChunkBytes ?? 7_500_000,
        maxFileBytes: this.config.fileShareMaxBytes ?? 512_000_000,
        archiveTempRoot: this.returnedArchiveRoot,
        archiverPath: this.config.fileShareArchiverPath,
      });
      const responseMessageIds = [];
      await liveMessage.edit(payloads[0]);
      responseMessageIds.push(liveMessage.id);
      for (const payload of payloads.slice(1)) {
        const sent = await message.channel.send(payload);
        responseMessageIds.push(sent.id);
      }
      let returnedFilePostsComplete = true;
      for (const payload of returnedFiles.payloads) {
        try {
          const sent = await message.channel.send(payload);
          responseMessageIds.push(sent.id);
        } catch (error) {
          returnedFilePostsComplete = false;
          this.#log('returned-file-post-failed', {
            conversationId,
            discordMessageId: message.id,
            error: error.message,
          });
          break;
        }
      }
      let returnedFileCleanup = 'retained';
      if (returnedFilePostsComplete && returnedFiles.cleanupAllowed) {
        try {
          await this.#removeReturnedFileOutputRoot(returnedFileOutputRoot);
          returnedFileCleanup = 'removed';
        } catch (error) {
          this.#log('returned-file-cleanup-failed', {
            conversationId,
            discordMessageId: message.id,
            error: error.message,
          });
        }
      }
      this.stateStore.setChatgptMessageRecord(conversationId, message.id, {
        state: 'completed',
        submitted: true,
        requestMessageId: result.requestMessageId ?? null,
        assistantMessageId: result.assistantMessageId ?? null,
        responseMessageIds,
        assistantAttachmentCount: result.assistantAttachments?.length ?? 0,
        returnedFileReadyCount: returnedFiles.readyCount,
        returnedFileUnavailableCount: returnedFiles.unavailableCount,
        returnedFilePostsComplete,
        returnedFileCleanup,
        returnedFileOutputRoot: returnedFileCleanup === 'removed' ? null : returnedFileOutputRoot,
        completedAt: new Date().toISOString(),
      });
      await message.react('✅').catch(() => {});
      await this.#repostConversationPanel(conversationId, message.channel);
      this.#log('message-completed', {
        conversationId,
        discordMessageId: message.id,
        requestMessageId: result.requestMessageId ?? null,
        assistantMessageId: result.assistantMessageId ?? null,
        responseMessageIds,
        returnedFileReadyCount: returnedFiles.readyCount,
        returnedFileUnavailableCount: returnedFiles.unavailableCount,
        returnedFileCleanup,
      });
    } catch (error) {
      if (renderTimer) {
        clearTimeout(renderTimer);
        this.renderTimers.delete(renderTimer);
      }
      const submissionStatus = String(error?.submissionStatus ?? 'NOT_STARTED').toUpperCase();
      const submissionUncertain = submissionStatus === 'POSSIBLE' || submissionStatus === 'CONFIRMED';
      this.stateStore.setChatgptMessageRecord(conversationId, message.id, {
        state: submissionUncertain ? 'uncertain' : 'failed',
        submitted: submissionStatus === 'CONFIRMED' ? true : submissionUncertain ? null : false,
        submissionStatus,
        error: truncate(error.message, 1_000),
      });
      const description = [
        submissionUncertain
          ? 'ChatGPTへの送信結果を確定できませんでした。二重送信を避けるため自動再送はしません。'
          : 'ChatGPTへ送信する前に失敗しました。',
        error?.code ? `エラーコード: ${truncate(error.code, 300)}` : '',
        `送信状態: ${submissionStatus}`,
        Number.isInteger(error?.transportStatus) ? `HTTP状態: ${error.transportStatus}` : '',
        error?.recoveryReason ? `復元状態: ${truncate(error.recoveryReason, 300)}` : '',
        error.partialResponse?.assistantText ? `\n途中応答:\n${truncate(error.partialResponse.assistantText, 2_500)}` : '',
        error.partialResult?.assistantText ? `\n復元済み応答:\n${truncate(error.partialResult.assistantText, 2_500)}` : '',
      ].filter(Boolean).join('\n');
      const payload = {
        embeds: [new EmbedBuilder().setTitle('ChatGPT error').setColor(ERROR_COLOR).setDescription(description)],
        allowedMentions: { parse: [] },
      };
      if (liveMessage) await liveMessage.edit(payload).catch(() => {});
      else await message.reply(payload).catch(() => {});
      await message.react('❌').catch(() => {});
    } finally {
      this.stateStore.setChatgptConversation(conversationId, { activeMessageId: null });
      await this.#setConversationActive(conversationId, false).catch(() => {});
      await this.#refreshControlPanel().catch(() => {});
      const pendingReaction = message.reactions?.resolve?.('⏳');
      await pendingReaction?.users?.remove?.(this.client.user.id).catch(() => {});
    }
  }

  async #removeReturnedFileOutputRoot(outputRoot) {
    const managedRoot = path.resolve(this.returnedFileRoot);
    const candidate = path.resolve(outputRoot);
    const relative = path.relative(managedRoot, candidate);
    const segments = relative.split(path.sep).filter(Boolean);
    if (segments.length !== 3 || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error('Refusing to remove a returned-file path outside the managed response root.');
    }
    await fs.promises.rm(candidate, { recursive: true, force: true });
    await fs.promises.rmdir(path.dirname(candidate)).catch(() => {});
    await fs.promises.rmdir(path.dirname(path.dirname(candidate))).catch(() => {});
  }

  async #upsertHistoryMessage(channel, messageId, payload) {
    const existing = messageId
      ? await channel.messages.fetch(messageId).catch(() => null)
      : null;
    if (existing?.author?.id === this.client.user.id) {
      await existing.edit({ ...payload, attachments: [] });
      return { message: existing, created: false };
    }
    return { message: await channel.send(payload), created: true };
  }

  async #syncConversationHistory(conversation, channel, history) {
    if (history?.kind !== 'reviewer-accessor.discord-chat-history'
      || history.schemaVersion !== 1
      || history.conversationId !== conversation.conversationId
      || history.limit !== 5
      || !Array.isArray(history.turns)
      || history.turns.length > history.limit
      || history.turns.some((turn) => !/^dht_[a-f0-9]{64}$/.test(String(turn?.turnId ?? '')))
      || new Set(history.turns.map((turn) => turn.turnId)).size !== history.turns.length) {
      throw new Error('reviewer-accessorから不正な履歴結果を受信しました。');
    }
    const summary = { returned: history.turns.length, created: 0, updated: 0, live: 0 };
    for (const turn of history.turns) {
      const stored = this.stateStore.chatgptHistoryRecord(conversation.conversationId, turn.turnId);
      const live = chatgptLiveRecordForHistoryTurn(conversation, turn);
      if (stored?.source === 'live' || (!stored && live)) {
        this.stateStore.setChatgptHistoryRecord(conversation.conversationId, turn.turnId, {
          source: 'live',
          status: turn.status,
          userSourceMessageId: turn.user?.messageId ?? null,
          assistantSourceMessageId: turn.assistantFinal?.messageId ?? null,
          discordUserMessageId: stored?.discordUserMessageId ?? live?.[0] ?? null,
          discordAssistantMessageId: stored?.discordAssistantMessageId ?? live?.[1]?.responseMessageIds?.[0] ?? null,
          syncedAt: new Date().toISOString(),
        });
        summary.live += 1;
        continue;
      }
      const [userPayload, assistantPayload] = chatgptHistoryTurnPayloads(turn);
      const userResult = await this.#upsertHistoryMessage(channel, stored?.discordUserMessageId, userPayload);
      this.stateStore.setChatgptHistoryRecord(conversation.conversationId, turn.turnId, {
        source: 'history',
        status: turn.status,
        userSourceMessageId: turn.user?.messageId ?? null,
        assistantSourceMessageId: turn.assistantFinal?.messageId ?? null,
        discordUserMessageId: userResult.message.id,
        discordAssistantMessageId: stored?.discordAssistantMessageId ?? null,
        syncedAt: new Date().toISOString(),
      });
      const assistantResult = await this.#upsertHistoryMessage(
        channel,
        stored?.discordAssistantMessageId,
        assistantPayload,
      );
      const created = userResult.created || assistantResult.created;
      summary[created ? 'created' : 'updated'] += 1;
      this.stateStore.setChatgptHistoryRecord(conversation.conversationId, turn.turnId, {
        source: 'history',
        status: turn.status,
        userSourceMessageId: turn.user?.messageId ?? null,
        assistantSourceMessageId: turn.assistantFinal?.messageId ?? null,
        discordUserMessageId: userResult.message.id,
        discordAssistantMessageId: assistantResult.message.id,
        syncedAt: new Date().toISOString(),
      });
    }
    this.stateStore.setChatgptConversation(conversation.conversationId, {
      lastHistorySyncAt: new Date().toISOString(),
      lastHistorySyncTurnCount: history.turns.length,
    });
    return summary;
  }

  async #handleInteraction(interaction) {
    const isCommand = interaction.isChatInputCommand?.() && interaction.commandName === 'chatgpt';
    const isComponent = String(interaction.customId ?? '').startsWith('cg:');
    if (!isCommand && !isComponent) return;
    if (interaction.guildId !== this.config.guildId) return;

    if (isCommand) {
      if (!this.#isAuthorizedUser(interaction.user.id)) return this.#rejectInteraction(interaction, true);
      const subcommand = interaction.options.getSubcommand();
      if (subcommand === 'link') {
        await interaction.deferReply({ ephemeral: true });
        const linked = await this.#linkConversation({
          conversationUrl: interaction.options.getString('url', true),
          name: interaction.options.getString('name'),
          responsePerformance: interaction.options.getString('performance'),
        });
        await interaction.editReply(messageOptions(`連携しました: <#${linked.channel.id}>`));
        return;
      }
      if (subcommand === 'list') {
        await interaction.reply(messageOptions(this.#conversationList(), { ephemeral: true }));
        return;
      }
      if (subcommand === 'status') {
        await this.#replyStatus(interaction);
      }
      return;
    }

    if (interaction.customId === 'cg:list') {
      if (!this.#isAuthorizedUser(interaction.user.id)) return this.#rejectInteraction(interaction, true);
      await interaction.reply(messageOptions(this.#conversationList(), { ephemeral: true }));
      return;
    }
    if (interaction.customId === 'cg:status') {
      if (!this.#isAuthorizedUser(interaction.user.id)) return this.#rejectInteraction(interaction, true);
      await this.#replyStatus(interaction);
      return;
    }
    if (interaction.customId === 'cg:open') {
      if (!this.#isAuthorizedUser(interaction.user.id)) return this.#rejectInteraction(interaction, true);
      const conversation = this.stateStore.chatgptConversation(interaction.values[0]);
      if (!conversation) throw new Error('連携済みChatGPT会話が見つかりません。');
      await interaction.reply(messageOptions(`<#${conversation.channelId}>`, { ephemeral: true }));
      return;
    }

    const parts = interaction.customId.split(':');
    const conversationId = parts[2];
    const conversation = this.stateStore.chatgptConversation(conversationId);
    if (!conversation || conversation.channelId !== interaction.channelId) {
      throw new Error('このChatGPT操作は現在の会話チャンネルに紐付いていません。');
    }
    if (!this.#canExecuteInteraction(interaction)) return this.#rejectInteraction(interaction, false);
    if (parts[1] === 'history') {
      if (conversation.activeMessageId) {
        await interaction.reply(messageOptions('ChatGPT応答の完了後に履歴を同期してください。', { ephemeral: true }));
        return;
      }
      await interaction.deferReply({ ephemeral: true });
      const history = await this.service.readHistory({
        conversationUrl: conversation.conversationUrl,
        limit: 5,
      });
      const summary = await this.#syncConversationHistory(conversation, interaction.channel, history);
      await this.#repostConversationPanel(conversationId, interaction.channel);
      await interaction.editReply(messageOptions([
        `直近${summary.returned}ターンを確認しました。`,
        `新規表示: ${summary.created} / 更新: ${summary.updated} / 既存ライブ表示: ${summary.live}`,
      ].join('\n')));
      this.#log('history-synced', {
        conversationId,
        userId: interaction.user.id,
        ...summary,
      });
      return;
    }
    if (parts[1] === 'performance') {
      const selected = interaction.values[0];
      this.stateStore.setChatgptConversation(conversationId, { responsePerformance: selected });
      await interaction.update(chatgptConversationPanelPayload(
        this.stateStore.chatgptConversation(conversationId),
      ));
      await this.#refreshControlPanel();
      return;
    }
    if (parts[1] === 'conversation-status') {
      await this.#replyStatus(interaction, conversation);
      return;
    }
    if (parts[1] === 'unlink') {
      if (!this.#isAuthorizedUser(interaction.user.id)) return this.#rejectInteraction(interaction, true);
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`cg:unlink-confirm:${conversationId}`)
          .setLabel('Discord連携を解除')
          .setStyle(ButtonStyle.Danger),
      );
      await interaction.reply(messageOptions(
        'このDiscordチャンネルを削除して連携を解除します。ChatGPT側の会話は変更しません。',
        { components: [row], ephemeral: true },
      ));
      return;
    }
    if (parts[1] === 'unlink-confirm') {
      if (!this.#isAuthorizedUser(interaction.user.id)) return this.#rejectInteraction(interaction, true);
      await interaction.reply(messageOptions('連携を解除しています…', { ephemeral: true }));
      this.stateStore.removeChatgptConversation(conversationId);
      await interaction.channel.delete('Explicit ChatGPT Discord unlink confirmation');
      await this.#refreshControlPanel();
    }
  }

  async #replyStatus(interaction, conversation = null) {
    await interaction.deferReply({ ephemeral: true });
    const selected = conversation ?? this.stateStore.chatgptConversationByChannel(interaction.channelId);
    const status = await this.service.status(selected?.conversationUrl ?? null);
    this.readyState = true;
    this.readyError = null;
    await this.#refreshControlPanel();
    const lines = [
      'reviewer-accessor: ready',
      `linked chats: ${this.stateStore.chatgptConversations().length}`,
      `running: ${this.service.activeCount}`,
    ];
    if (selected) {
      lines.push(
        `conversation: ${selected.conversationId}`,
        `transport: ${status.transport}`,
        `profile: ${status.profile}`,
        'browser session: checked on send',
      );
    }
    await interaction.editReply(messageOptions(lines.join('\n')));
  }

  #conversationList() {
    const conversations = this.stateStore.chatgptConversations();
    if (conversations.length === 0) return '連携済みChatGPT会話はありません。`/chatgpt link` で追加してください。';
    return conversations.map((conversation) => [
      `- <#${conversation.channelId}>`,
      `\`${conversation.conversationId}\``,
      conversation.responsePerformance,
    ].join(' · ')).join('\n');
  }

  async #refreshControlPanel() {
    if (!this.infrastructure) return;
    const payload = chatgptControlPanelPayload({
      conversations: this.stateStore.chatgptConversations(),
      ready: this.readyState,
      activeCount: this.service.activeCount,
    });
    const storedId = this.stateStore.infrastructure().chatgptControlPanelMessageId;
    let message = storedId
      ? this.infrastructure.control.messages.cache?.get?.(storedId) ?? null
      : null;
    if (!message && storedId) {
      message = await this.infrastructure.control.messages.fetch(storedId).catch(() => null);
    }
    if (message && interactionMarker(message) !== CHATGPT_CONTROL_PANEL_MARKER) message = null;
    if (!message) {
      const recent = await this.infrastructure.control.messages.fetch({ limit: 100 }).catch(() => null);
      message = recent ? [...recent.values()].find((candidate) => candidate.author.id === this.client.user.id
        && interactionMarker(candidate) === CHATGPT_CONTROL_PANEL_MARKER) : null;
    }
    if (!message) message = await this.infrastructure.control.send(payload);
    else await message.edit(payload);
    if (!message.pinned && typeof message.pin === 'function') await message.pin('Keep ChatGPT Remote controls available').catch(() => {});
    if (message.id !== storedId) {
      this.stateStore.setInfrastructure({ chatgptControlPanelMessageId: message.id });
    }
  }

  async #ensureConversationPanel(conversation, channel) {
    const marker = chatgptConversationPanelMarker(conversation.conversationId);
    let message = conversation.controlPanelMessageId
      ? await channel.messages.fetch(conversation.controlPanelMessageId).catch(() => null)
      : null;
    if (message && interactionMarker(message) !== marker) message = null;
    if (!message) {
      const recent = await channel.messages.fetch({ limit: 100 }).catch(() => null);
      message = recent ? [...recent.values()].find((candidate) => candidate.author.id === this.client.user.id
        && interactionMarker(candidate) === marker) : null;
    }
    const payload = chatgptConversationPanelPayload(conversation);
    if (!message) message = await channel.send(payload);
    else await message.edit(payload);
    if (!message.pinned && typeof message.pin === 'function') await message.pin('Keep ChatGPT conversation controls available').catch(() => {});
    if (message.id !== conversation.controlPanelMessageId) {
      this.stateStore.setChatgptConversation(conversation.conversationId, { controlPanelMessageId: message.id });
    }
    return message;
  }

  async #repostConversationPanel(conversationId, channel) {
    const conversation = this.stateStore.chatgptConversation(conversationId);
    if (!conversation) return;
    const oldPanel = conversation.controlPanelMessageId
      ? await channel.messages.fetch(conversation.controlPanelMessageId).catch(() => null)
      : null;
    const newPanel = await channel.send(chatgptConversationPanelPayload({ ...conversation, activeMessageId: null }));
    if (typeof newPanel.pin === 'function') await newPanel.pin('Place ChatGPT controls below the latest answer').catch(() => {});
    this.stateStore.setChatgptConversation(conversationId, { controlPanelMessageId: newPanel.id });
    if (oldPanel && oldPanel.id !== newPanel.id && oldPanel.author.id === this.client.user.id) {
      await oldPanel.delete().catch(() => {});
    }
  }

  async #setConversationActive(conversationId, active) {
    const conversation = this.stateStore.chatgptConversation(conversationId);
    if (!conversation?.channelId) return;
    const channel = await this.client.channels.fetch(conversation.channelId).catch(() => null);
    if (!channel) return;
    const desired = channelName(conversation, active);
    if (channel.name !== desired) await channel.setName(desired, 'Reflect ChatGPT response state');
    const panel = this.stateStore.chatgptConversation(conversationId);
    await this.#ensureConversationPanel(panel, channel);
  }

  async #recoverInterruptedMessages() {
    for (const conversation of this.stateStore.chatgptConversations()) {
      const interrupted = Object.entries(conversation.messageRecords ?? {})
        .filter(([, record]) => ['queued', 'dispatching'].includes(record.state));
      for (const [messageId, record] of interrupted) {
        this.stateStore.setChatgptMessageRecord(conversation.conversationId, messageId, {
          state: 'uncertain',
          submitted: record.state === 'queued' ? false : null,
          error: 'Discord Bridge restarted before delivery state was finalized.',
        });
        if (record.liveMessageId && conversation.channelId) {
          const channel = await this.client.channels.fetch(conversation.channelId).catch(() => null);
          const message = channel
            ? await channel.messages.fetch(record.liveMessageId).catch(() => null)
            : null;
          await message?.edit({
            embeds: [new EmbedBuilder()
              .setTitle('ChatGPT delivery state unknown')
              .setColor(WARNING_COLOR)
              .setDescription('Bridge再起動前の送信結果を確定できません。二重送信を避けるため自動再送はしていません。')],
            allowedMentions: { parse: [] },
          }).catch(() => {});
        }
      }
      if (conversation.activeMessageId || interrupted.length > 0) {
        this.stateStore.setChatgptConversation(conversation.conversationId, { activeMessageId: null });
      }
    }
  }

  #isAuthorizedUser(userId) {
    return this.authorizedUserIds.includes(userId);
  }

  #hasDiscordPermission(permissions) {
    return Boolean(permissions?.has?.(PermissionFlagsBits.ViewChannel)
      && permissions.has(PermissionFlagsBits.SendMessages));
  }

  #canExecuteMessage(message) {
    if (this.#isAuthorizedUser(message.author?.id)) return true;
    const permissions = message.memberPermissions
      ?? message.member?.permissionsIn?.(message.channel)
      ?? message.channel?.permissionsFor?.(message.member ?? message.author);
    return this.#hasDiscordPermission(permissions);
  }

  #canExecuteInteraction(interaction) {
    return this.#isAuthorizedUser(interaction.user?.id)
      || this.#hasDiscordPermission(interaction.memberPermissions);
  }

  async #rejectInteraction(interaction, requireAdministrator) {
    const content = requireAdministrator
      ? '拒否しました。ChatGPT会話の登録・解除には設定済み管理ユーザー権限が必要です。'
      : '拒否しました。このChatGPTチャンネルの表示・送信権限が必要です。';
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(messageOptions(content, { ephemeral: true })).catch(() => {});
    } else {
      await interaction.reply(messageOptions(content, { ephemeral: true })).catch(() => {});
    }
  }

  async #interactionError(interaction, error) {
    this.#log('interaction-error', {
      command: interaction.commandName ?? null,
      customId: interaction.customId ?? null,
      error: error.stack ?? error.message,
    });
    const detail = error?.code
      ? `${truncate(error.code, 300)}: ${truncate(error.message, 1_350)}`
      : truncate(error.message, 1_700);
    const payload = messageOptions(`ChatGPT操作に失敗しました: ${detail}`, { ephemeral: true });
    if (interaction.deferred) await interaction.editReply(payload).catch(() => {});
    else if (interaction.replied) await interaction.followUp(payload).catch(() => {});
    else await interaction.reply(payload).catch(() => {});
  }

  #log(event, details) {
    appendJsonLine(this.logPath, event, details);
  }
}
