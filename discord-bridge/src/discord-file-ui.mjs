import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} from 'discord.js';
import { truncate } from './util.mjs';

export const FILE_BROWSER_PAGE_SIZE = 25;

export function formatFileSize(size) {
  if (!Number.isFinite(size)) return '';
  if (size < 1024) return `${size} B`;
  if (size < 1024 ** 2) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 ** 3) return `${(size / 1024 ** 2).toFixed(1)} MB`;
  return `${(size / 1024 ** 3).toFixed(1)} GB`;
}

export function linkedFilesComponents(count) {
  if (!count) return [];
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('cx:files:linked')
      .setLabel(`Linked files (${count})`)
      .setStyle(ButtonStyle.Secondary),
  )];
}

function entryLabel(entry) {
  const icon = entry.lockedReason ? 'LOCK' : entry.kind === 'directory' ? 'DIR' : 'FILE';
  return truncate(`${icon} ${entry.name}`, 100, '');
}

function entryDescription(entry) {
  if (entry.lockedReason) return truncate(`取得不可: ${entry.lockedReason}`, 100, '');
  if (entry.kind === 'directory') return 'ディレクトリを開く';
  return truncate(`ダウンロード ${formatFileSize(entry.size)}`, 100, '');
}

export function fileBrowserPayload(session) {
  const pageCount = Math.max(1, Math.ceil(session.entries.length / FILE_BROWSER_PAGE_SIZE));
  const page = Math.min(Math.max(0, session.page ?? 0), pageCount - 1);
  const start = page * FILE_BROWSER_PAGE_SIZE;
  const visible = session.entries.slice(start, start + FILE_BROWSER_PAGE_SIZE);
  const displayPath = session.relativeDirectory ? `.\\${session.relativeDirectory}` : '.\\';
  const embed = new EmbedBuilder()
    .setTitle('Project files')
    .setColor(0x1971c2)
    .setDescription(`\`${truncate(displayPath, 3900)}\``)
    .addFields(
      { name: 'Entries', value: String(session.entries.length), inline: true },
      { name: 'Page', value: `${page + 1}/${pageCount}`, inline: true },
    )
    .setFooter({ text: `task ${session.threadId}` });
  const rows = [];
  if (visible.length > 0) {
    rows.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`cx:files:browse:${session.key}`)
        .setPlaceholder('開くフォルダまたは取得するファイルを選択')
        .addOptions(visible.map((entry, offset) => new StringSelectMenuOptionBuilder()
          .setLabel(entryLabel(entry))
          .setDescription(entryDescription(entry))
          .setValue(String(start + offset)))),
    ));
  }
  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`cx:files:nav:${session.key}:up`).setLabel('Up').setStyle(ButtonStyle.Secondary).setDisabled(!session.relativeDirectory),
    new ButtonBuilder().setCustomId(`cx:files:nav:${session.key}:prev`).setLabel('Prev').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
    new ButtonBuilder().setCustomId(`cx:files:nav:${session.key}:next`).setLabel('Next').setStyle(ButtonStyle.Secondary).setDisabled(page >= pageCount - 1),
    new ButtonBuilder().setCustomId(`cx:files:nav:${session.key}:refresh`).setLabel('Refresh').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`cx:files:nav:${session.key}:close`).setLabel('Close').setStyle(ButtonStyle.Secondary),
  ));
  return { embeds: [embed], components: rows, allowedMentions: { parse: [] } };
}

export function linkedFilePickerPayload(session) {
  const pageCount = Math.max(1, Math.ceil(session.items.length / FILE_BROWSER_PAGE_SIZE));
  const page = Math.min(Math.max(0, session.page ?? 0), pageCount - 1);
  const start = page * FILE_BROWSER_PAGE_SIZE;
  const visible = session.items.slice(start, start + FILE_BROWSER_PAGE_SIZE);
  const embed = new EmbedBuilder()
    .setTitle('Linked files')
    .setColor(0x5865f2)
    .setDescription(`Codexメッセージに記載されたローカルファイルを選択してください。\nPage ${page + 1}/${pageCount}`)
    .setFooter({ text: `task ${session.threadId}` });
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`cx:files:linkedpick:${session.key}`)
    .setPlaceholder('ダウンロードするファイルを選択')
    .addOptions(visible.map((item, index) => new StringSelectMenuOptionBuilder()
      .setLabel(truncate(`${item.error ? 'LOCK' : 'FILE'} ${item.reference.label}`, 100, ''))
      .setDescription(truncate(item.error ? `取得不可: ${item.error}` : item.file.relativePath, 100, ''))
      .setValue(String(start + index))));
  const components = [new ActionRowBuilder().addComponents(menu)];
  if (pageCount > 1) {
    components.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`cx:files:linkednav:${session.key}:prev`).setLabel('Prev').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
      new ButtonBuilder().setCustomId(`cx:files:linkednav:${session.key}:next`).setLabel('Next').setStyle(ButtonStyle.Secondary).setDisabled(page >= pageCount - 1),
      new ButtonBuilder().setCustomId(`cx:files:linkednav:${session.key}:close`).setLabel('Close').setStyle(ButtonStyle.Secondary),
    ));
  }
  return {
    embeds: [embed],
    components,
    allowedMentions: { parse: [] },
  };
}
