import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { ChannelType, Client, GatewayIntentBits } from 'discord.js';
import { dataDir, loadConfig } from '../src/config.mjs';

const config = loadConfig();
const token = process.env.DISCORD_BOT_TOKEN;
if (!token) throw new Error('DISCORD_BOT_TOKEN is not set.');

const state = JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'));
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const timeout = setTimeout(() => {
  process.stderr.write('Discord layout verification timed out after 60 seconds.\n');
  client.destroy();
  process.exitCode = 1;
}, 60_000);

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
  const taskChannels = textChannels.filter((channel) => channel.topic?.includes('Codex task: '));
  const activeTasks = taskChannels.filter((channel) => channel.topic?.includes('\nState: active'));
  const archivedTasks = taskChannels.filter((channel) => channel.topic?.includes('\nState: archived'));
  const archiveCategoryIds = new Set(archiveCategories.map((category) => category.id));
  const projectCategoryIds = new Set(projectCategories.map((category) => category.id));
  const referencedProjectCategoryIds = new Set(Object.values(state.projectCategories ?? {})
    .flatMap((project) => project.categoryIds ?? []));
  const command = commands.find((candidate) => candidate.name === 'codex');
  const commandNames = command?.options.map((option) => option.name) ?? [];
  const requiredCommands = [
    'status', 'tasks', 'open', 'deliver', 'send', 'steer', 'compose', 'interrupt', 'watch', 'pending', 'sync', 'refresh',
    'model', 'reasoning', 'permissions', 'mode', 'memory', 'usage', 'resources', 'goal', 'compact', 'fork', 'review', 'terminals', 'help',
  ];
  const removedCommands = ['autocatchup', 'catchup', 'bind', 'unbind'].filter((name) => commandNames.includes(name));
  const errors = [];
  let taskPanels = 0;

  const customIds = (message) => message.components
    .flatMap((row) => row.components.map((component) => component.customId).filter(Boolean));
  const verifyPanel = async (channel, messageId, marker, requiredIds) => {
    if (!messageId) {
      errors.push(`${channel?.name ?? '(unknown channel)'}: control panel message ID is missing.`);
      return null;
    }
    const message = channel ? await channel.messages.fetch(messageId).catch(() => null) : null;
    if (!message) {
      errors.push(`${channel?.name ?? '(unknown channel)'}: control panel ${messageId} is unavailable.`);
      return null;
    }
    if (!message.pinned) errors.push(`${channel.name}: control panel ${messageId} is not pinned.`);
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
  if (archiveCategories.size === 0) errors.push(`Missing archive category: ${config.archiveCategoryName}`);
  if (projectCategories.size === 0) errors.push('No project categories were found.');
  const duplicateProjectNames = [...new Set(projectCategories.map((category) => category.name))]
    .filter((name) => projectCategories.filter((category) => category.name === name).size > 1);
  if (duplicateProjectNames.length) errors.push(`Duplicate project categories remain: ${duplicateProjectNames.join(', ')}`);
  if (projectCategories.some((category) => !referencedProjectCategoryIds.has(category.id))) {
    errors.push('An unreferenced project category remains in Discord.');
  }
  if (activeTasks.some((channel) => !projectCategoryIds.has(channel.parentId))) {
    errors.push('At least one active task is outside a project category.');
  }
  if (archivedTasks.some((channel) => !archiveCategoryIds.has(channel.parentId))) {
    errors.push('At least one archived task is outside an archive category.');
  }
  if (removedCommands.length) errors.push(`Removed commands remain registered: ${removedCommands.join(', ')}`);
  const missingCommands = requiredCommands.filter((name) => !commandNames.includes(name));
  if (missingCommands.length) errors.push(`Required commands are missing: ${missingCommands.join(', ')}`);
  if (taskChannels.size !== Object.keys(state.bindings ?? {}).length) {
    errors.push(`Task channel count ${taskChannels.size} does not match state bindings ${Object.keys(state.bindings ?? {}).length}.`);
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
        'cx:ui:control:resources',
        ...(Object.keys(state.bindings ?? {}).length ? ['cx:ui:control:open'] : []),
      ],
    );
  }
  for (const [threadId, binding] of Object.entries(state.bindings ?? {})) {
    const channel = textChannels.get(binding.channelId);
    if (!channel) continue;
    const panel = await verifyPanel(
      channel,
      binding.controlPanelMessageId,
      `Codex Remote UI / task-panel / ${threadId}`,
      [
        `cx:ui:task:compose:${threadId}`,
        `cx:ui:task:watch:${threadId}`,
        `cx:ui:task:refresh:${threadId}`,
        `cx:ui:task:pending:${threadId}`,
        `cx:ui:task:controls:${threadId}`,
        `cx:ui:task:archive:${threadId}`,
        `cx:ui:task:interrupt:${threadId}`,
      ],
    );
    if (panel) taskPanels += 1;
  }

  process.stdout.write(`${JSON.stringify({
    ok: errors.length === 0,
    control: { category: controlCategory?.name ?? null, channel: controlChannel?.name ?? null },
    projects: [...projectCategories.values()].map((category) => ({ name: category.name, children: category.children.cache.size })),
    archives: [...archiveCategories.values()].map((category) => ({ name: category.name, children: category.children.cache.size })),
    tasks: { total: taskChannels.size, active: activeTasks.size, archived: archivedTasks.size },
    panels: { control: Boolean(state.infrastructure.controlPanelMessageId), tasks: taskPanels },
    commands: commandNames,
    errors,
  }, null, 2)}\n`);
  if (errors.length) process.exitCode = 1;
} finally {
  clearTimeout(timeout);
  client.destroy();
}
