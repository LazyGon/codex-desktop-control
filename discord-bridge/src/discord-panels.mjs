import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} from 'discord.js';
import {
  threadStatusEmoji,
  threadStatusLabel,
  truncate,
} from './util.mjs';

export const CONTROL_PANEL_MARKER = 'Codex Remote UI / control-panel';
export const taskPanelMarker = (threadId) => `Codex Remote UI / task-panel / ${threadId}`;
export const CONTROL_PANEL_COLOR = 0x7048e8;

export function controlPanelPayload({ bindings, connected, pendingCount, projectCount }) {
  const active = bindings.filter((binding) => !binding.archived);
  const archived = bindings.filter((binding) => binding.archived);
  const embed = new EmbedBuilder()
    .setTitle('Codex Remote')
    .setColor(connected ? CONTROL_PANEL_COLOR : 0xc92a2a)
    .addFields(
      { name: 'app-server', value: connected ? 'Connected' : 'Reconnecting', inline: true },
      { name: 'Active', value: String(active.length), inline: true },
      { name: 'Archived', value: String(archived.length), inline: true },
      { name: 'Projects', value: String(projectCount), inline: true },
      { name: 'Pending', value: String(pendingCount), inline: true },
    )
    .setFooter({ text: CONTROL_PANEL_MARKER });

  const components = [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('cx:ui:control:status').setLabel('Status').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('cx:ui:control:usage').setLabel('Usage').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('cx:ui:control:sync').setLabel('Sync').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('cx:ui:control:pending').setLabel('Pending').setStyle(ButtonStyle.Secondary),
  )];
  components.push(new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('cx:ui:control:resources')
      .setPlaceholder('Codexリソースを表示')
      .addOptions(
        new StringSelectMenuOptionBuilder().setLabel('MCP servers').setValue('mcp'),
        new StringSelectMenuOptionBuilder().setLabel('Skills').setValue('skills'),
        new StringSelectMenuOptionBuilder().setLabel('Plugins').setValue('plugins'),
        new StringSelectMenuOptionBuilder().setLabel('Hooks').setValue('hooks'),
        new StringSelectMenuOptionBuilder().setLabel('Experimental features').setValue('features'),
      ),
  ));
  const tasks = [...bindings]
    .sort((left, right) => Number(left.archived) - Number(right.archived)
      || String(left.name ?? left.threadId).localeCompare(String(right.name ?? right.threadId)))
    .slice(0, 25);
  if (tasks.length > 0) {
    components.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('cx:ui:control:open')
        .setPlaceholder('タスクチャンネルを開く')
        .addOptions(tasks.map((binding) => new StringSelectMenuOptionBuilder()
          .setLabel(truncate(`${binding.archived ? '📦' : threadStatusEmoji({ type: binding.taskStatus })} ${binding.name ?? binding.threadId}`, 100, ''))
          .setDescription(truncate(binding.cwd ?? '(no project)', 100, ''))
          .setValue(binding.threadId))),
    ));
  }
  return { embeds: [embed], components, allowedMentions: { parse: [] } };
}

export function taskPanelPayload({ thread, binding }) {
  const archived = Boolean(binding.archived);
  const active = thread.status?.type === 'active';
  const watchLevel = binding.watchLevel ?? 'normal';
  const marker = taskPanelMarker(thread.id);
  const embed = new EmbedBuilder()
    .setTitle(truncate(thread.name ?? thread.preview ?? 'Codex task', 256, ''))
    .setColor(CONTROL_PANEL_COLOR)
    .addFields(
      { name: 'Status', value: archived ? 'archived' : threadStatusLabel(thread.status), inline: true },
      { name: 'Watch', value: watchLevel, inline: true },
      { name: 'Task ID', value: `\`${thread.id}\`` },
      { name: 'Project', value: `\`${truncate(thread.cwd ?? binding.cwd ?? '(none)', 1000)}\`` },
    )
    .setFooter({ text: marker });

  const compose = new StringSelectMenuBuilder()
    .setCustomId(`cx:ui:task:compose:${thread.id}`)
    .setPlaceholder('指示の送信方法を選択')
    .setDisabled(archived)
    .addOptions(
      new StringSelectMenuOptionBuilder().setLabel('自動').setDescription('稼働中は追加、停止中は新しいターン').setValue('deliver'),
      new StringSelectMenuOptionBuilder().setLabel('新しいターン').setDescription('停止中のタスクへ送信').setValue('send'),
      new StringSelectMenuOptionBuilder().setLabel('追加指示').setDescription('現在のターンへ送信').setValue('steer'),
    );
  const watch = new StringSelectMenuBuilder()
    .setCustomId(`cx:ui:task:watch:${thread.id}`)
    .setPlaceholder('通知レベル')
    .addOptions(['quiet', 'normal', 'verbose'].map((level) => new StringSelectMenuOptionBuilder()
      .setLabel(level)
      .setValue(level)
      .setDefault(level === watchLevel)));
  const actions = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`cx:ui:task:refresh:${thread.id}`).setLabel('Refresh').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`cx:ui:task:pending:${thread.id}`).setLabel('Pending').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`cx:ui:task:controls:${thread.id}`).setLabel('Controls').setStyle(ButtonStyle.Primary).setDisabled(archived),
    new ButtonBuilder()
      .setCustomId(`cx:ui:task:archive:${thread.id}`)
      .setLabel(archived ? 'Restore' : 'Archive')
      .setStyle(archived ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`cx:ui:task:interrupt:${thread.id}`)
      .setLabel('Interrupt')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(archived || !active),
  );
  return {
    embeds: [embed],
    components: [
      new ActionRowBuilder().addComponents(compose),
      new ActionRowBuilder().addComponents(watch),
      actions,
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`cx:ui:task:files:${thread.id}`)
          .setLabel('Project files')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(`cx:ui:task:project:${thread.id}`)
          .setLabel('Download project')
          .setEmoji('📦')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(`cx:ui:task:git:${thread.id}`)
          .setLabel('Download .git')
          .setEmoji('🗃️')
          .setStyle(ButtonStyle.Secondary),
      ),
    ],
    allowedMentions: { parse: [] },
  };
}
