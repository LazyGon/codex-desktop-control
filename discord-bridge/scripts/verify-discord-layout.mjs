import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {
  ChannelType,
  Client,
  GatewayIntentBits,
  PermissionFlagsBits,
} from 'discord.js';
import { dataDir, loadConfig } from '../src/config.mjs';
import { createDiscordRestAgent, discordRestOptions } from '../src/discord-network.mjs';
import { CONTROL_PANEL_COLOR } from '../src/discord-panels.mjs';
import {
  CHATGPT_COLOR,
  CHATGPT_CONTROL_PANEL_MARKER,
  chatgptConversationPanelMarker,
} from '../src/chatgpt-panels.mjs';
import {
  projectDescriptorForThread,
  readDesktopProjectSnapshot,
} from '../src/desktop-project-state.mjs';

const config = loadConfig();
const token = process.env.DISCORD_BOT_TOKEN;
if (!token) throw new Error('DISCORD_BOT_TOKEN is not set.');

const state = JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'));
const desktopProjects = readDesktopProjectSnapshot(config.desktopGlobalStatePath);
const discordRestAgent = createDiscordRestAgent(config);
const client = new Client({
  intents: [GatewayIntentBits.Guilds],
  rest: discordRestOptions(config, discordRestAgent),
});
const timeout = setTimeout(() => {
  process.stderr.write('Discord layout verification timed out after 300 seconds.\n');
  client.destroy();
  process.exitCode = 1;
}, 300_000);

try {
  await client.login(token);
  if (!client.isReady()) await new Promise((resolve) => client.once('clientReady', resolve));
  clearTimeout(timeout);

  const guild = await client.guilds.fetch(config.guildId);
  const channels = await guild.channels.fetch();
  const commands = await guild.commands.fetch();
  const categories = channels.filter((channel) => channel?.type === ChannelType.GuildCategory);
  const textChannels = channels.filter((channel) => channel?.type === ChannelType.GuildText);
  const controlCategory = categories.find((category) => category.name === config.controlCategoryName);
  const archiveCategories = categories.filter((category) => category.name === config.archiveCategoryName
    || category.name.startsWith(`${config.archiveCategoryName} (`));
  const projectCategories = categories.filter((category) => category.name.startsWith(config.projectCategoryPrefix));
  const controlChannel = textChannels.find((channel) => channel.name === config.controlChannelName);
  const syncChannel = textChannels.find((channel) => channel.name === config.syncChannelName);
  const chatgptCategory = config.chatgptEnabled
    ? categories.find((category) => category.name === config.chatgptCategoryName)
    : null;
  const chatgptControlChannel = config.chatgptEnabled
    ? textChannels.find((channel) => channel.name === config.chatgptControlChannelName
      && channel.parentId === controlCategory?.id)
    : null;
  const chatgptChannels = config.chatgptEnabled && chatgptCategory
    ? textChannels.filter((channel) => channel.parentId === chatgptCategory.id
      && channel.topic?.startsWith('ChatGPT conversation: '))
    : new Map();
  const transferCategory = config.textTransferEnabled
    ? categories.find((category) => category.name === config.transferCategoryName)
    : null;
  const transferTextChannel = config.textTransferEnabled && transferCategory
    ? textChannels.find((channel) => channel.parentId === transferCategory.id
      && channel.name === config.transferTextChannelName)
    : null;
  const taskChannels = textChannels.filter((channel) => channel.topic?.includes('Codex task: '));
  const activeTasks = taskChannels.filter((channel) => channel.topic?.includes('\nState: active'));
  const archivedTasks = taskChannels.filter((channel) => channel.topic?.includes('\nState: archived'));
  const archiveCategoryIds = new Set(archiveCategories.map((category) => category.id));
  const projectCategoryIds = new Set(projectCategories.map((category) => category.id));
  const visibleBindings = Object.entries(state.bindings ?? {})
    .filter(([, binding]) => !binding.hidden && !state.hiddenProjects?.[binding.projectKey]);
  const referencedProjectCategoryIds = new Set(Object.entries(state.projectCategories ?? {})
    .filter(([projectKey]) => !state.hiddenProjects?.[projectKey])
    .map(([, project]) => project)
    .flatMap((project) => project.categoryIds ?? []));
  const activeBindings = visibleBindings
    .filter(([, binding]) => !binding.archived);
  const expectedProjectlessBindings = activeBindings.filter(([threadId, binding]) => (
    projectDescriptorForThread(
      { id: threadId, cwd: binding.cwd },
      desktopProjects,
      config.projectCategoryPrefix,
    ).key === '__no_project__'
  ));
  const noProjectRecord = state.projectCategories?.__no_project__ ?? null;
  const command = commands.find((candidate) => candidate.name === 'codex');
  const filesCommand = commands.find((candidate) => candidate.name === 'codex-files');
  const chatgptCommand = commands.find((candidate) => candidate.name === 'chatgpt');
  const commandNames = command?.options.map((option) => option.name) ?? [];
  const requiredCommands = [
    'status', 'tasks', 'open', 'deliver', 'send', 'steer', 'compose', 'interrupt', 'watch', 'pending', 'sync', 'refresh',
    'model', 'reasoning', 'permissions', 'mode', 'memory', 'usage', 'resources', 'goal', 'compact', 'fork', 'review', 'terminals', 'help',
  ];
  const attachmentCommands = ['deliver', 'send'].map((name) => (
    command?.options.find((option) => option.name === name)
  ));
  const removedCommands = ['autocatchup', 'catchup', 'bind', 'unbind'].filter((name) => commandNames.includes(name));
  const errors = [];
  let taskPanels = 0;
  const privateCategories = [
    ...(controlCategory ? [controlCategory] : []),
    ...archiveCategories.values(),
    ...projectCategories.values(),
    ...(transferCategory ? [transferCategory] : []),
    ...(chatgptCategory ? [chatgptCategory] : []),
  ];

  const customIds = (message) => message.components
    .flatMap((row) => row.components.map((component) => component.customId).filter(Boolean));
  const verifyPanel = async (
    channel,
    messageId,
    marker,
    requiredIds,
    color = CONTROL_PANEL_COLOR,
    expectedPinned = true,
    expectedLatest = false,
  ) => {
    if (!messageId) {
      errors.push(`${channel?.name ?? '(unknown channel)'}: control panel message ID is missing.`);
      return null;
    }
    const message = channel ? await channel.messages.fetch(messageId).catch(() => null) : null;
    if (!message) {
      errors.push(`${channel?.name ?? '(unknown channel)'}: control panel ${messageId} is unavailable.`);
      return null;
    }
    if (expectedPinned && !message.pinned) errors.push(`${channel.name}: control panel ${messageId} is not pinned.`);
    if (!expectedPinned && message.pinned) errors.push(`${channel.name}: control panel ${messageId} is still pinned.`);
    if (expectedLatest) {
      const recent = await channel.messages.fetch({ limit: 1 }).catch(() => null);
      const latest = recent?.first?.() ?? [...(recent?.values?.() ?? [])][0] ?? null;
      if (latest?.id !== message.id) errors.push(`${channel.name}: control panel ${messageId} is not the latest message.`);
    }
    if (message.embeds[0]?.color !== color) {
      errors.push(`${channel.name}: control panel ${messageId} does not use the dedicated control color.`);
    }
    if (!message.embeds.some((embed) => embed.footer?.text === marker)) {
      errors.push(`${channel.name}: control panel ${messageId} has the wrong identity marker.`);
    }
    const ids = customIds(message);
    for (const requiredId of requiredIds) {
      if (!ids.includes(requiredId)) errors.push(`${channel.name}: control panel is missing ${requiredId}.`);
    }
    return message;
  };

  if (!controlCategory) errors.push(`Missing control category: ${config.controlCategoryName}`);
  if (!controlChannel) errors.push(`Missing control channel: ${config.controlChannelName}`);
  if (controlChannel && controlChannel.parentId !== controlCategory?.id) errors.push('Control channel has the wrong parent.');
  if (!syncChannel) errors.push(`Missing sync channel: ${config.syncChannelName}`);
  if (syncChannel && syncChannel.parentId !== controlCategory?.id) errors.push('Sync channel has the wrong parent.');
  if (syncChannel && state.infrastructure.syncChannelId !== syncChannel.id) {
    errors.push('Sync channel ID does not match persisted state.');
  }
  if (config.textTransferEnabled && !transferCategory) {
    errors.push(`Missing transfer category: ${config.transferCategoryName}`);
  }
  if (config.textTransferEnabled && !transferTextChannel) {
    errors.push(`Missing transfer channel: ${config.transferTextChannelName}`);
  }
  if (config.chatgptEnabled && !chatgptCategory) {
    errors.push(`Missing ChatGPT category: ${config.chatgptCategoryName}`);
  }
  if (config.chatgptEnabled && !chatgptControlChannel) {
    errors.push(`Missing ChatGPT control channel: ${config.chatgptControlChannelName}`);
  }
  if (chatgptCategory && state.infrastructure.chatgptCategoryId !== chatgptCategory.id) {
    errors.push('ChatGPT category ID does not match persisted state.');
  }
  if (chatgptControlChannel
    && state.infrastructure.chatgptControlChannelId !== chatgptControlChannel.id) {
    errors.push('ChatGPT control channel ID does not match persisted state.');
  }
  if (transferCategory && state.infrastructure.transferCategoryId !== transferCategory.id) {
    errors.push('Transfer category ID does not match persisted state.');
  }
  if (transferTextChannel && state.infrastructure.transferTextChannelId !== transferTextChannel.id) {
    errors.push('Transfer channel ID does not match persisted state.');
  }
  if (archiveCategories.size === 0) errors.push(`Missing archive category: ${config.archiveCategoryName}`);
  if (projectCategories.size === 0) errors.push('No project categories were found.');
  const duplicateProjectNames = [...new Set(projectCategories.map((category) => category.name))]
    .filter((name) => projectCategories.filter((category) => category.name === name).size > 1);
  if (duplicateProjectNames.length) errors.push(`Duplicate project categories remain: ${duplicateProjectNames.join(', ')}`);
  if (projectCategories.some((category) => !referencedProjectCategoryIds.has(category.id))) {
    errors.push('An unreferenced project category remains in Discord.');
  }
  if (!desktopProjects.available) {
    errors.push(`Codex Desktop project state is unavailable: ${desktopProjects.error}`);
  } else if (expectedProjectlessBindings.length > 0) {
    if (!noProjectRecord) {
      errors.push('The shared projectless category is missing from persisted state.');
    } else {
      const noProjectCategoryIds = noProjectRecord.categoryIds ?? [];
      if (noProjectCategoryIds.length !== 1) {
        errors.push(`Projectless tasks use ${noProjectCategoryIds.length} categories instead of one.`);
      }
      for (const [threadId, binding] of expectedProjectlessBindings) {
        if (binding.projectKey !== '__no_project__') {
          errors.push(`Projectless task ${threadId} has project key ${binding.projectKey}.`);
        }
        if (!noProjectCategoryIds.includes(binding.categoryId)) {
          errors.push(`Projectless task ${threadId} is outside the shared category.`);
        }
      }
    }
  }
  if (activeTasks.some((channel) => !projectCategoryIds.has(channel.parentId))) {
    errors.push('At least one active task is outside a project category.');
  }
  if (archivedTasks.some((channel) => !archiveCategoryIds.has(channel.parentId))) {
    errors.push('At least one archived task is outside an archive category.');
  }
  if (removedCommands.length) errors.push(`Removed commands remain registered: ${removedCommands.join(', ')}`);
  if (!filesCommand) errors.push('Required command is missing: codex-files');
  if (config.chatgptEnabled && !chatgptCommand) errors.push('Required command is missing: chatgpt');
  const chatgptCommandNames = chatgptCommand?.options.map((option) => option.name) ?? [];
  for (const name of ['link', 'list', 'status']) {
    if (config.chatgptEnabled && !chatgptCommandNames.includes(name)) {
      errors.push(`Required ChatGPT command is missing: chatgpt ${name}`);
    }
  }
  const missingCommands = requiredCommands.filter((name) => !commandNames.includes(name));
  if (missingCommands.length) errors.push(`Required commands are missing: ${missingCommands.join(', ')}`);
  for (const attachmentCommand of attachmentCommands) {
    const attachmentOption = attachmentCommand?.options?.find((option) => option.name === 'attachment');
    if (!attachmentOption) {
      errors.push(`Attachment option is missing from codex ${attachmentCommand?.name ?? '(unknown)'}.`);
    } else if (/200\s*KB|画像または.*テキスト/i.test(attachmentOption.description ?? '')) {
      errors.push(`codex ${attachmentCommand.name} still advertises the legacy image/text-only attachment limit.`);
    }
  }
  if (taskChannels.size !== visibleBindings.length) {
    errors.push(`Task channel count ${taskChannels.size} does not match visible state bindings ${visibleBindings.length}.`);
  }
  if (config.chatgptEnabled
    && chatgptChannels.size !== Object.keys(state.chatgptConversations ?? {}).length) {
    errors.push(`ChatGPT channel count ${chatgptChannels.size} does not match explicit links ${Object.keys(state.chatgptConversations ?? {}).length}.`);
  }
  if (controlChannel) {
    await verifyPanel(
      controlChannel,
      state.infrastructure.controlPanelMessageId,
      'Codex Remote UI / control-panel',
      [
        'cx:ui:control:status',
        'cx:ui:control:usage',
        'cx:ui:control:sync',
        'cx:ui:control:pending',
        'cx:ui:control:recent-history',
        'cx:ui:control:projects',
        'cx:ui:control:resources',
        ...(visibleBindings.length ? ['cx:ui:control:open'] : []),
      ],
      CONTROL_PANEL_COLOR,
      false,
      true,
    );
  }
  if (chatgptControlChannel) {
    await verifyPanel(
      chatgptControlChannel,
      state.infrastructure.chatgptControlPanelMessageId,
      CHATGPT_CONTROL_PANEL_MARKER,
      [
        'cg:list',
        'cg:status',
        ...(Object.keys(state.chatgptConversations ?? {}).length ? ['cg:open'] : []),
      ],
      CHATGPT_COLOR,
    );
  }
  for (const category of privateCategories) {
    const overwrites = category.permissionOverwrites.cache;
    const everyone = overwrites.get(guild.roles.everyone.id);
    if (!everyone?.deny.has(PermissionFlagsBits.ViewChannel)) {
      errors.push(`${category.name}: @everyone is not denied ViewChannel.`);
    }
    const botPermissions = category.permissionsFor(guild.members.me);
    for (const permission of [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.ReadMessageHistory,
      PermissionFlagsBits.ManageChannels,
      PermissionFlagsBits.ManageMessages,
    ]) {
      if (!botPermissions?.has(permission)) {
        errors.push(`${category.name}: Bridge bot is missing permission ${permission}.`);
      }
    }
  }
  for (const [threadId, binding] of visibleBindings) {
    const channel = textChannels.get(binding.channelId);
    if (!channel) continue;
    const panel = await verifyPanel(
      channel,
      binding.controlPanelMessageId,
      `Codex Remote UI / task-panel / ${threadId}`,
      [
        `cx:ui:task:compose:${threadId}`,
        `cx:ui:task:actions:${threadId}`,
        `cx:ui:task:notifications:${threadId}`,
        `cx:ui:task:file-actions:${threadId}`,
      ],
      CONTROL_PANEL_COLOR,
      false,
    );
    if (panel) taskPanels += 1;
  }
  for (const [conversationId, conversation] of Object.entries(state.chatgptConversations ?? {})) {
    const channel = textChannels.get(conversation.channelId);
    if (!channel) {
      errors.push(`Explicit ChatGPT conversation ${conversationId} has no Discord channel.`);
      continue;
    }
    if (channel.parentId !== chatgptCategory?.id) {
      errors.push(`Explicit ChatGPT conversation ${conversationId} is outside the ChatGPT category.`);
    }
    await verifyPanel(
      channel,
      conversation.controlPanelMessageId,
      chatgptConversationPanelMarker(conversationId),
      [
        `cg:performance:${conversationId}`,
        `cg:conversation-status:${conversationId}`,
        `cg:unlink:${conversationId}`,
      ],
      CHATGPT_COLOR,
    );
  }

  process.stdout.write(`${JSON.stringify({
    ok: errors.length === 0,
    control: {
      category: controlCategory?.name ?? null,
      channel: controlChannel?.name ?? null,
      syncChannel: syncChannel?.name ?? null,
    },
    transfer: {
      enabled: config.textTransferEnabled,
      category: transferCategory?.name ?? null,
      channel: transferTextChannel?.name ?? null,
    },
    chatgpt: {
      enabled: config.chatgptEnabled,
      category: chatgptCategory?.name ?? null,
      controlChannel: chatgptControlChannel?.name ?? null,
      explicitLinks: Object.keys(state.chatgptConversations ?? {}).length,
      channels: chatgptChannels.size,
    },
    projects: [...projectCategories.values()].map((category) => ({ name: category.name, children: category.children.cache.size })),
    projectless: {
      desktopStateAvailable: desktopProjects.available,
      tasks: expectedProjectlessBindings.length,
      categories: noProjectRecord?.categoryIds?.length ?? 0,
    },
    archives: [...archiveCategories.values()].map((category) => ({ name: category.name, children: category.children.cache.size })),
    tasks: { total: taskChannels.size, active: activeTasks.size, archived: archivedTasks.size },
    access: {
      controlOperators: config.authorizedUserIds.length,
      completionSubscribers: config.completionMentionUserIds.length,
      privateCategories: privateCategories.length,
    },
    panels: { control: Boolean(state.infrastructure.controlPanelMessageId), tasks: taskPanels },
    commands: [
      ...commandNames.map((name) => `codex ${name}`),
      ...(filesCommand ? ['codex-files'] : []),
      ...chatgptCommandNames.map((name) => `chatgpt ${name}`),
    ],
    errors,
  }, null, 2)}\n`);
  if (errors.length) process.exitCode = 1;
} finally {
  clearTimeout(timeout);
  client.destroy();
  await discordRestAgent.close();
}
