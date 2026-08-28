import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} from 'discord.js';
import { truncate } from './util.mjs';

export const CHATGPT_COLOR = 0x10a37f;
export const CHATGPT_CONTROL_PANEL_MARKER = 'ChatGPT Remote control panel v1';
export const chatgptConversationPanelMarker = (conversationId) => `ChatGPT conversation panel v1 | ${conversationId}`;

export function chatgptControlPanelPayload({ conversations = [], ready = false, activeCount = 0 } = {}) {
  const active = conversations.filter((value) => value.activeMessageId).length;
  const embed = new EmbedBuilder()
    .setTitle('ChatGPT Remote')
    .setColor(ready ? CHATGPT_COLOR : 0xc92a2a)
    .setDescription([
      '通常ChatGPT会話を `reviewer-accessor` 経由で利用します。',
      '自動検出はせず、`/chatgpt link` で指定した会話だけを列挙します。',
    ].join('\n'))
    .addFields(
      { name: 'reviewer-accessor', value: ready ? 'ready' : 'unavailable', inline: true },
      { name: 'Linked chats', value: String(conversations.length), inline: true },
      { name: 'Running', value: String(Math.max(active, activeCount)), inline: true },
    )
    .setFooter({ text: CHATGPT_CONTROL_PANEL_MARKER })
    .setTimestamp();
  const controls = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('cg:list')
      .setLabel('一覧')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('cg:status')
      .setLabel('状態更新')
      .setStyle(ButtonStyle.Secondary),
  );
  const components = [controls];
  if (conversations.length > 0) {
    components.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('cg:open')
        .setPlaceholder('連携済みChatGPT会話を開く')
        .addOptions(conversations.slice(0, 25).map((conversation) => new StringSelectMenuOptionBuilder()
          .setLabel(truncate(conversation.name || conversation.conversationId, 100, ''))
          .setDescription(truncate(`${conversation.activeMessageId ? '応答中' : '待機中'} · ${conversation.responsePerformance}`, 100, ''))
          .setValue(conversation.conversationId))),
    ));
  }
  return { embeds: [embed], components, allowedMentions: { parse: [] } };
}

export function chatgptConversationPanelPayload(conversation) {
  const active = Boolean(conversation.activeMessageId);
  const embed = new EmbedBuilder()
    .setTitle('ChatGPT conversation')
    .setColor(CHATGPT_COLOR)
    .setDescription('このチャンネルの通常メッセージを、紐付け済みChatGPT会話へ送ります。')
    .addFields(
      { name: 'Name', value: truncate(conversation.name || 'ChatGPT', 1024), inline: true },
      { name: 'State', value: active ? '🟢 responding' : '⚫ ready', inline: true },
      { name: 'Performance', value: conversation.responsePerformance, inline: true },
      { name: 'Conversation', value: `\`${conversation.conversationId}\`` },
    )
    .setFooter({ text: chatgptConversationPanelMarker(conversation.conversationId) })
    .setTimestamp();
  const performance = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`cg:performance:${conversation.conversationId}`)
      .setPlaceholder('応答性能を変更')
      .addOptions([
        ['Fastest', 'fastest'],
        ['Medium', 'medium'],
        ['High', 'high'],
        ['Very high', 'very-high'],
        ['Pro', 'pro'],
      ].map(([label, value]) => new StringSelectMenuOptionBuilder()
        .setLabel(label)
        .setValue(value)
        .setDefault(value === conversation.responsePerformance))),
  );
  const controls = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`cg:history:${conversation.conversationId}`)
      .setLabel('最近5ターン同期')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(active),
    new ButtonBuilder()
      .setCustomId(`cg:conversation-status:${conversation.conversationId}`)
      .setLabel('状態')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`cg:unlink:${conversation.conversationId}`)
      .setLabel('連携解除')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(active),
  );
  return { embeds: [embed], components: [performance, controls], allowedMentions: { parse: [] } };
}
