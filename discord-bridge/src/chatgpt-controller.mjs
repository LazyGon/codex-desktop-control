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
import { appendJsonLine, sanitizeChannelName, truncate } from './util.mjs';

const ERROR_COLOR = 0xc92a2a;
const WARNING_COLOR = 0xf0b232;
const RESPONSE_CHUNK_LENGTH = 3_900;
const MAX_RESPONSE_POSTS = 5;
const ATTACHMENT_ONLY_PROMPT = [
  '添付ファイルがユーザーからの依頼です。',
  '内容を読み取り、意図を判断して、可能な分析・回答・作業を進めてください。',
  '単なる確認だけで終わらず、意図を確定できない場合だけ質問してください。',
].join('');

function messageOptions(content, extra = {}) {
  return { content, allowedMentions: { parse: [] }, ...extra };
}

function splitText(value, maximum = RESPONSE_CHUNK_LENGTH) {
  const input = String(value ?? '');
  if (!input) return ['(応答本文なし)'];
  const chunks = [];
  let remaining = input;
  while (remaining.length > maximum) {
    let end = remaining.lastIndexOf('\n', maximum);
    if (end < Math.floor(maximum * 0.55)) end = remaining.lastIndexOf(' ', maximum);
    if (end < Math.floor(maximum * 0.55)) end = maximum;
    chunks.push(remaining.slice(0, end));
    remaining = remaining.slice(end).replace(/^\s+/, '');
  }
  if (remaining || chunks.length === 0) chunks.push(remaining);
  return chunks;
}

export function chatgptResponsePayloads(text, { assistantAttachments = [] } = {}) {
  let completeText = String(text ?? '').trim() || '(応答本文なし)';
  if (assistantAttachments.length > 0) {
    const names = assistantAttachments
      .map((attachment) => attachment?.name ?? attachment?.fileName ?? attachment?.id)
      .filter(Boolean);
    completeText += [
      '',
      '---',
      `ChatGPT returned ${assistantAttachments.length} file(s)${names.length ? `: ${names.join(', ')}` : ''}.`,
      '返却ファイル本体のDiscord転送はこの連携範囲に含まれていません。',
    ].join('\n');
  }
  const chunks = splitText(completeText);
  const payloads = [];
  const previewCount = chunks.length > MAX_RESPONSE_POSTS ? MAX_RESPONSE_POSTS - 1 : chunks.length;
  for (let index = 0; index < previewCount; index += 1) {
    payloads.push({
      embeds: [new EmbedBuilder()
        .setTitle(index === 0 ? 'ChatGPT answer' : `ChatGPT answer (${index + 1}/${chunks.length})`)
        .setColor(CHATGPT_COLOR)
        .setDescription(chunks[index])],
      allowedMentions: { parse: [] },
    });
  }
  if (chunks.length > MAX_RESPONSE_POSTS) {
    payloads.push({
      embeds: [new EmbedBuilder()
        .setTitle('ChatGPT answer (complete text)')
        .setColor(CHATGPT_COLOR)
        .setDescription(`全文は添付ファイルを参照してください（${completeText.length}文字）。`)],
      files: [new AttachmentBuilder(Buffer.from(completeText, 'utf8'), { name: 'chatgpt-answer.txt' })],
      allowedMentions: { parse: [] },
    });
  }
  return payloads;
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
    const state = this.stateStore.snapshot();
    const controlCategory = channels.get(state.infrastructure.controlCategoryId);
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

    let category = state.infrastructure.chatgptCategoryId
      ? channels.get(state.infrastructure.chatgptCategoryId)
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

    let control = state.infrastructure.chatgptControlChannelId
      ? channels.get(state.infrastructure.chatgptControlChannelId)
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
      });
      const responseMessageIds = [];
      await liveMessage.edit(payloads[0]);
      responseMessageIds.push(liveMessage.id);
      for (const payload of payloads.slice(1)) {
        const sent = await message.channel.send(payload);
        responseMessageIds.push(sent.id);
      }
      this.stateStore.setChatgptMessageRecord(conversationId, message.id, {
        state: 'completed',
        submitted: true,
        requestMessageId: result.requestMessageId ?? null,
        assistantMessageId: result.assistantMessageId ?? null,
        responseMessageIds,
        assistantAttachmentCount: result.assistantAttachments?.length ?? 0,
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
      });
    } catch (error) {
      if (renderTimer) {
        clearTimeout(renderTimer);
        this.renderTimers.delete(renderTimer);
      }
      const dispatching = this.stateStore.chatgptMessageRecord(conversationId, message.id)?.state === 'dispatching';
      this.stateStore.setChatgptMessageRecord(conversationId, message.id, {
        state: dispatching ? 'uncertain' : 'failed',
        submitted: dispatching ? null : false,
        error: truncate(error.message, 1_000),
      });
      const description = [
        dispatching
          ? 'ChatGPTへの送信結果を確定できませんでした。二重送信を避けるため自動再送はしません。'
          : 'ChatGPTへ送信する前に失敗しました。',
        truncate(error.message, 3_000),
        error.partialResponse?.assistantText ? `\n途中応答:\n${truncate(error.partialResponse.assistantText, 2_500)}` : '',
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
        `cache: ${status.cached ? 'present' : 'missing (first send will bootstrap)'}`,
        `auth: ${status.authFresh ? 'fresh' : 'refresh required'}`,
        `conversation state: ${status.conversationStateUsable ? 'usable' : 'bootstrap required'}`,
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
    const storedId = this.stateStore.snapshot().infrastructure.chatgptControlPanelMessageId;
    let message = storedId
      ? await this.infrastructure.control.messages.fetch(storedId).catch(() => null)
      : null;
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
    const payload = messageOptions(`ChatGPT操作に失敗しました: ${truncate(error.message, 1_700)}`, { ephemeral: true });
    if (interaction.deferred) await interaction.editReply(payload).catch(() => {});
    else if (interaction.replied) await interaction.followUp(payload).catch(() => {});
    else await interaction.reply(payload).catch(() => {});
  }

  #log(event, details) {
    appendJsonLine(this.logPath, event, details);
  }
}
