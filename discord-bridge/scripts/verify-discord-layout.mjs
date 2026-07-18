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
  process.stderr.write('Discord layout verification timed out after 30 seconds.\n');
  client.destroy();
  process.exitCode = 1;
}, 30_000);

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
  const removedCommands = ['autocatchup', 'catchup', 'bind', 'unbind'].filter((name) => commandNames.includes(name));
  const errors = [];

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
  if (!commandNames.includes('sync')) errors.push('The /codex sync command is missing.');
  if (taskChannels.size !== Object.keys(state.bindings ?? {}).length) {
    errors.push(`Task channel count ${taskChannels.size} does not match state bindings ${Object.keys(state.bindings ?? {}).length}.`);
  }

  process.stdout.write(`${JSON.stringify({
    ok: errors.length === 0,
    control: { category: controlCategory?.name ?? null, channel: controlChannel?.name ?? null },
    projects: [...projectCategories.values()].map((category) => ({ name: category.name, children: category.children.cache.size })),
    archives: [...archiveCategories.values()].map((category) => ({ name: category.name, children: category.children.cache.size })),
    tasks: { total: taskChannels.size, active: activeTasks.size, archived: archivedTasks.size },
    commands: commandNames,
    errors,
  }, null, 2)}\n`);
  if (errors.length) process.exitCode = 1;
} finally {
  clearTimeout(timeout);
  client.destroy();
}
