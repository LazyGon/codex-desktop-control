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
import {
  MAX_RECENT_HISTORY_DAYS,
  RECENT_HISTORY_DAY_OPTIONS,
} from './recent-history.mjs';

export const CONTROL_PANEL_MARKER = 'Codex Remote UI / control-panel';
export const taskPanelMarker = (threadId) => `Codex Remote UI / task-panel / ${threadId}`;
export const CONTROL_PANEL_COLOR = 0x7048e8;

export function controlPanelPayload({
  bindings,
  connected,
  pendingCount,
  projectCount,
  hiddenProjectCount = 0,
}) {
  const active = bindings.filter((binding) => !binding.archived);
  const archived = bindings.filter((binding) => binding.archived);
  const embed = new EmbedBuilder()
    .setTitle('Codex Remote')
    .setColor(connected ? CONTROL_PANEL_COLOR : 0xc92a2a)
    .addFields(
      { name: 'app-server', value: connected ? 'Connected' : 'Reconnecting', inline: true },
      { name: 'Active', value: String(active.length), inline: true },
      { name: 'Archived', value: String(archived.length), inline: true },
      { name: 'Projects', value: hiddenProjectCount > 0
        ? `表示 ${projectCount} / 非表示 ${hiddenProjectCount}`
        : String(projectCount), inline: true },
      { name: 'Pending', value: String(pendingCount), inline: true },
    )
    .setFooter({ text: CONTROL_PANEL_MARKER });

  const components = [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('cx:ui:control:status').setLabel('Status').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('cx:ui:control:usage').setLabel('Usage').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('cx:ui:control:sync').setLabel('Sync').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('cx:ui:control:pending').setLabel('Pending').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('cx:ui:control:recent-history').setLabel('履歴復元').setStyle(ButtonStyle.Secondary),
  )];
  components.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('cx:ui:control:projects')
      .setLabel('プロジェクト表示')
      .setStyle(ButtonStyle.Secondary),
  ));
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

export function projectVisibilityPayload({ projects, key, page = 0 }) {
  const pageSize = 25;
  const pageCount = Math.max(1, Math.ceil(projects.length / pageSize));
  const currentPage = Math.min(Math.max(0, page), pageCount - 1);
  const start = currentPage * pageSize;
  const entries = projects.slice(start, start + pageSize);
  const hiddenCount = projects.filter((project) => project.hidden).length;
  const embed = new EmbedBuilder()
    .setTitle('プロジェクトのDiscord表示')
    .setColor(CONTROL_PANEL_COLOR)
    .setDescription([
      '選択したプロジェクトをDiscordから非表示、または再表示します。',
      '非表示ではDiscord側のカテゴリとその配下チャンネル（タスクチャンネルやサブエージェントスレッドを含む）、関連する完了通知を削除します。Codexのtask/threadとローカルファイルは削除しません。',
      '再表示すると、Codexに残る履歴からDiscordミラーを作り直します。Discordだけに存在した途中カードや添付は復元できません。',
    ].join('\n'))
    .addFields(
      { name: '表示', value: String(projects.length - hiddenCount), inline: true },
      { name: '非表示', value: String(hiddenCount), inline: true },
      { name: 'Page', value: `${currentPage + 1}/${pageCount}`, inline: true },
    );
  const components = [];
  if (entries.length > 0) {
    components.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`cx:projects:${key}:select`)
        .setPlaceholder('非表示・再表示するプロジェクトを選択')
        .addOptions(entries.map((project, index) => new StringSelectMenuOptionBuilder()
          .setLabel(truncate(`${project.hidden ? '👁️ 再表示' : '🚫 非表示'}: ${project.name}`, 100, ''))
          .setDescription(truncate(project.path ?? '(no project)', 100, ''))
          .setValue(String(start + index)))),
    ));
  }
  components.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`cx:projects:${key}:prev`)
      .setLabel('Previous')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(currentPage === 0),
    new ButtonBuilder()
      .setCustomId(`cx:projects:${key}:next`)
      .setLabel('Next')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(currentPage >= pageCount - 1),
    new ButtonBuilder()
      .setCustomId(`cx:projects:${key}:refresh`)
      .setLabel('Refresh')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`cx:projects:${key}:close`)
      .setLabel('Close')
      .setStyle(ButtonStyle.Secondary),
  ));
  return { embeds: [embed], components, allowedMentions: { parse: [] } };
}

export function recentHistoryPayload() {
  const embed = new EmbedBuilder()
    .setTitle('最近の履歴を復元')
    .setColor(CONTROL_PANEL_COLOR)
    .setDescription([
      'Discord管理対象の全ての非アーカイブタスクについて、選択期間内の履歴カードを復元します。',
      'ユーザー発言、commentary、最終回答に加え、App Serverが保持する推論要約を復元します。',
      'アーカイブ済みタスクと、期間より前の履歴は変更しません。',
    ].join('\n'));
  const select = new StringSelectMenuBuilder()
    .setCustomId('cx:ui:control:recent-history-days')
    .setPlaceholder(`復元する期間を選択（最大${MAX_RECENT_HISTORY_DAYS}日）`)
    .addOptions(RECENT_HISTORY_DAY_OPTIONS.map((days) => (
      new StringSelectMenuOptionBuilder()
        .setLabel(`過去${days}日`)
        .setDescription(`直近${days * 24}時間の履歴を復元`)
        .setValue(String(days))
    )));
  return {
    embeds: [embed],
    components: [new ActionRowBuilder().addComponents(select)],
    allowedMentions: { parse: [] },
  };
}

export function taskPanelPayload({ thread, binding }) {
  const archived = Boolean(binding.archived);
  const active = thread.status?.type === 'active';
  const watchLevel = binding.watchLevel ?? 'normal';
  const watchLabel = { quiet: '少なめ', normal: '標準', verbose: '詳しく' }[watchLevel] ?? watchLevel;
  const completionReportsEnabled = binding.completionReportsEnabled !== false;
  const marker = taskPanelMarker(thread.id);
  const forkSource = binding.forkedFromThreadId
    ? [
      binding.forkedFromChannelId ? `<#${binding.forkedFromChannelId}>` : null,
      `task \`${binding.forkedFromThreadId}\``,
    ].filter(Boolean).join(' / ')
    : null;
  const embed = new EmbedBuilder()
    .setTitle(truncate(thread.name ?? thread.preview ?? 'Codex task', 256, ''))
    .setColor(CONTROL_PANEL_COLOR)
    .addFields(
      { name: 'Status', value: archived ? 'archived' : threadStatusLabel(thread.status), inline: true },
      { name: 'Watch', value: watchLevel, inline: true },
      { name: 'Completion report', value: completionReportsEnabled ? 'ON' : 'OFF', inline: true },
      { name: 'Task ID', value: `\`${thread.id}\`` },
      ...(forkSource ? [{ name: 'Forked from', value: forkSource }] : []),
      { name: 'Project', value: `\`${truncate(thread.cwd ?? binding.cwd ?? '(none)', 1000)}\`` },
    )
    .setFooter({ text: marker });

  const compose = new StringSelectMenuBuilder()
    .setCustomId(`cx:ui:task:compose:${thread.id}`)
    .setPlaceholder('💬 指示を送る')
    .setDisabled(archived)
    .addOptions(
      new StringSelectMenuOptionBuilder().setLabel('自動で送信').setDescription('稼働中は追加、停止中は新しいターン').setValue('deliver').setEmoji('✨'),
      new StringSelectMenuOptionBuilder().setLabel('新しいターンとして送信').setDescription('停止中のタスクへ新しい指示を送信').setValue('send').setEmoji('🆕'),
      new StringSelectMenuOptionBuilder().setLabel('実行中のターンへ追加').setDescription('現在の処理へ追加指示を送信').setValue('steer').setEmoji('↪️'),
    );
  const taskActions = new StringSelectMenuBuilder()
    .setCustomId(`cx:ui:task:actions:${thread.id}`)
    .setPlaceholder('⚙️ タスクを管理')
    .addOptions(
      new StringSelectMenuOptionBuilder()
        .setLabel('状態を更新')
        .setDescription('最新の状態と実行設定を読み直す')
        .setValue('refresh')
        .setEmoji('🔄'),
      new StringSelectMenuOptionBuilder()
        .setLabel('確認待ちを表示')
        .setDescription('承認・質問・入力待ちを確認する')
        .setValue('pending')
        .setEmoji('📥'),
    );
  if (!archived) {
    taskActions.addOptions(new StringSelectMenuOptionBuilder()
      .setLabel('実行設定を開く')
      .setDescription('モデル・推論・権限などを変更する')
      .setValue('controls')
      .setEmoji('🛠️'));
  }
  if (!archived && active) {
    taskActions.addOptions(new StringSelectMenuOptionBuilder()
      .setLabel('実行を中断')
      .setDescription('確認してから現在のターンを停止する')
      .setValue('interrupt')
      .setEmoji('⏹️'));
  }
  taskActions.addOptions(new StringSelectMenuOptionBuilder()
    .setLabel(archived ? 'タスクを復元' : 'タスクをアーカイブ')
    .setDescription(archived ? '通常のプロジェクトカテゴリへ戻す' : 'アーカイブカテゴリへ移動する')
    .setValue('archive')
    .setEmoji(archived ? '♻️' : '🗄️'));

  const notifications = new StringSelectMenuBuilder()
    .setCustomId(`cx:ui:task:notifications:${thread.id}`)
    .setPlaceholder(`🔔 通知を設定（進行: ${watchLabel} / 完了: ${completionReportsEnabled ? 'ON' : 'OFF'}）`)
    .addOptions(
      new StringSelectMenuOptionBuilder().setLabel('進行通知: 少なめ').setDescription('重要な進行だけを表示').setValue('watch:quiet').setEmoji('🔕'),
      new StringSelectMenuOptionBuilder().setLabel('進行通知: 標準').setDescription('通常の進行を表示').setValue('watch:normal').setEmoji('🔔'),
      new StringSelectMenuOptionBuilder().setLabel('進行通知: 詳しく').setDescription('詳細な進行も表示').setValue('watch:verbose').setEmoji('📣'),
      new StringSelectMenuOptionBuilder().setLabel('完了通知: 投稿する').setDescription('codex-completionsへ完了報告を投稿').setValue('completion:enabled').setEmoji('✅'),
      new StringSelectMenuOptionBuilder().setLabel('完了通知: 投稿しない').setDescription('結果はタスクチャンネル内だけに残す').setValue('completion:disabled').setEmoji('🚫'),
    );

  const fileActions = new StringSelectMenuBuilder()
    .setCustomId(`cx:ui:task:file-actions:${thread.id}`)
    .setPlaceholder('📁 ファイルを開く・取得')
    .addOptions(
      new StringSelectMenuOptionBuilder().setLabel('プロジェクト内を見る').setDescription('フォルダを移動して個別ファイルを取得').setValue('files').setEmoji('📂'),
      new StringSelectMenuOptionBuilder().setLabel('プロジェクト全体を取得').setDescription('確認後、分割archiveとして投稿').setValue('project').setEmoji('📦'),
      new StringSelectMenuOptionBuilder().setLabel('.gitだけを取得').setDescription('確認後、Git metadataだけを投稿').setValue('git').setEmoji('🗃️'),
    );
  return {
    embeds: [embed],
    components: [
      new ActionRowBuilder().addComponents(compose),
      new ActionRowBuilder().addComponents(taskActions),
      new ActionRowBuilder().addComponents(notifications),
      new ActionRowBuilder().addComponents(fileActions),
    ],
    allowedMentions: { parse: [] },
  };
}
