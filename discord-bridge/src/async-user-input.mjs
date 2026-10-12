import { createHash } from 'node:crypto';
import {
  ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder,
  ModalBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder,
  TextInputBuilder, TextInputStyle,
} from 'discord.js';
import { isAsyncQuestionItem, truncate } from './util.mjs';

const OPTIONS_PER_PAGE = 24; // Discord allows 25 options; reserve one for free text.
export function questionReplyId(itemId, index) {
  return JSON.stringify(['request_user_input_async', itemId, index]);
}

export function questionReplyText(record, answer) {
  const json = JSON.stringify([{ questionItemId: record.questionItemId, question: record.title, answer }])
    .replaceAll('<', '\\u003c').replaceAll('>', '\\u003e');
  return `<send_user_message_question_reply>\n${json}\n</send_user_message_question_reply>`;
}

export function questionReplies(item) {
  if (item?.type !== 'userMessage') return [];
  const text = item.text ?? (item.content ?? []).map(part => part.text ?? '').join('\n');
  const replies = [];
  for (const match of String(text).matchAll(/<send_user_message_question_reply>\s*([\s\S]*?)\s*<\/send_user_message_question_reply>/g)) {
    try {
      const values = JSON.parse(match[1]);
      if (!Array.isArray(values)) continue;
      replies.push(...values.filter(value => typeof value?.questionItemId === 'string' && typeof value.answer === 'string'));
    } catch { /* Ordinary user text is not a structured question reply. */ }
  }
  return replies;
}

export function asyncQuestionPayload(record) {
  const open = record.phase === 'open' || record.phase === 'prepared' || record.phase === 'posting';
  const pages = Math.max(1, Math.ceil(record.options.length / OPTIONS_PER_PAGE));
  const page = Math.min(pages - 1, Math.max(0, record.page ?? 0));
  const embed = new EmbedBuilder().setTitle('Codexからの質問')
    .setColor(open ? 0xf0b232 : 0x7289da)
    .setDescription(truncate(record.title, 4096))
    .addFields({ name: '状態', value: open ? '回答待ち（タスクは並行して作業できます）'
      : record.phase === 'answered' ? '回答済み' : '配送状態を確認するまで再送しません' })
    .setFooter({ text: `async-question:${record.key}` });
  const rows = [];
  if (record.options.length && open) {
    const menu = new StringSelectMenuBuilder().setCustomId(`cx:aq:${record.key}:select`)
      .setPlaceholder('選択肢を選ぶ、または自由入力');
    record.options.slice(page * OPTIONS_PER_PAGE, (page + 1) * OPTIONS_PER_PAGE).forEach((option, offset) => {
      menu.addOptions(new StringSelectMenuOptionBuilder().setLabel(truncate(`${page * OPTIONS_PER_PAGE + offset + 1}. ${option}`, 100, ''))
        .setValue(String(page * OPTIONS_PER_PAGE + offset)));
    });
    menu.addOptions(new StringSelectMenuOptionBuilder().setLabel('自由入力').setValue('__other__'));
    rows.push(new ActionRowBuilder().addComponents(menu));
  }
  if (open) {
    const row = new ActionRowBuilder().addComponents(new ButtonBuilder()
      .setCustomId(`cx:aq:${record.key}:write`).setLabel('回答を入力').setStyle(ButtonStyle.Primary));
    if (pages > 1) row.addComponents(
      new ButtonBuilder().setCustomId(`cx:aq:${record.key}:prev`).setLabel('前の選択肢')
        .setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
      new ButtonBuilder().setCustomId(`cx:aq:${record.key}:next`).setLabel('次の選択肢')
        .setStyle(ButtonStyle.Secondary).setDisabled(page === pages - 1),
    );
    rows.push(row);
  }
  const payload = { content: '', embeds: [embed], components: rows, allowedMentions: { parse: [] } };
  if (record.title.length > 4096 || record.options.some((option, index) => `${index + 1}. ${option}`.length > 100)) {
    const fullText = [record.title, ...record.options.map((option, index) => `${index + 1}. ${option}`)].join('\n\n');
    payload.files = [new AttachmentBuilder(Buffer.from(fullText, 'utf8'), { name: 'codex-question.txt' })];
  }
  return payload;
}

// This is an asynchronous message, not a pending JSON-RPC server request.
// Never answer it using respondToServerRequest or change task permissions.
export class AsyncUserInputController {
  constructor({ client, codex, stateStore, instanceId = 'local', log = () => {} }) {
    Object.assign(this, { client, codex, stateStore, instanceId, log });
    this.posts = new Map();
  }

  register(binding, turnId, item) {
    if (!isAsyncQuestionItem(item)) return [];
    if (!item.id || !turnId) throw new Error('A question needs its exact item and turn identity.');
    return item.questions.map((question, index) => {
      if (typeof question.title !== 'string' || !question.title.trim()
        || (question.options != null && (!Array.isArray(question.options)
          || question.options.some(option => typeof option !== 'string' || !option.trim())))) {
        throw new Error('Invalid asynchronous question schema.');
      }
      const key = createHash('sha256').update(JSON.stringify([this.instanceId, binding.threadId, turnId, item.id, index])).digest('hex').slice(0, 24);
      const existing = this.stateStore.asyncQuestion(key);
      if (existing) return existing;
      this.stateStore.setAsyncQuestion(key, {
        key, threadId: binding.threadId, channelId: binding.channelId, turnId, itemId: item.id,
        questionItemId: questionReplyId(item.id, index), title: question.title,
        options: question.options ?? [], phase: 'prepared', page: 0, messageId: null,
      });
      return this.stateStore.asyncQuestion(key);
    });
  }

  async ensure(binding, turnId, item) {
    for (const record of this.register(binding, turnId, item)) await this.#post(record.key);
  }

  async restoreTurns(binding, turns) {
    const keys = new Set();
    for (const turn of turns) for (const item of turn.items ?? []) {
      for (const record of this.register(binding, turn.id, item)) keys.add(record.key);
    }
    // Recognize replies before exposing historical prompts as unanswered.
    for (const turn of turns) for (const item of turn.items ?? []) await this.observeReply(binding, item);
    for (const key of keys) await this.#post(key);
  }

  async #post(key) {
    if (this.posts.has(key)) return this.posts.get(key);
    const post = this.#postOnce(key);
    this.posts.set(key, post);
    try { return await post; } finally { this.posts.delete(key); }
  }

  async #postOnce(key) {
    const record = this.stateStore.asyncQuestion(key);
    if (record.messageId || ['posting', 'postUnknown', 'dispatching', 'deliveryUnknown', 'preparing'].includes(record.phase)) return;
    const channel = await this.client.channels.fetch(record.channelId);
    const payload = asyncQuestionPayload(record);
    this.stateStore.setAsyncQuestion(key, { phase: 'posting' });
    try {
      const message = await channel.send(payload);
      const answered = record.phase === 'answered' || this.stateStore.asyncQuestion(key).phase === 'answered';
      this.stateStore.setAsyncQuestion(key, { messageId: message.id, phase: answered ? 'answered' : 'open' });
      if (answered) await this.#refresh(this.stateStore.asyncQuestion(key)).catch(() => {});
    } catch (error) {
      this.stateStore.setAsyncQuestion(key, { phase: 'postUnknown' });
      this.log('async-question-post-unknown', { key, threadId: record.threadId });
      throw error;
    }
  }

  async #refresh(record) {
    if (!record.messageId) return;
    const channel = await this.client.channels.fetch(record.channelId);
    const message = await channel.messages.fetch(record.messageId);
    await message.edit({ ...asyncQuestionPayload(record), attachments: [] });
  }

  async observeReply(binding, item) {
    const replies = questionReplies(item);
    if (!replies.length) return;
    for (const record of this.stateStore.asyncQuestions(binding.threadId)) {
      if (record.phase === 'answered' || !replies.some(reply => reply.questionItemId === record.questionItemId)) continue;
      this.stateStore.setAsyncQuestion(record.key, { phase: 'answered', answeredBy: 'persisted-user-message', answerItemId: item.id ?? null });
      await this.#refresh(this.stateStore.asyncQuestion(record.key)).catch(() => {});
    }
  }

  async handleInteraction(interaction) {
    const parts = String(interaction.customId ?? '').split(':');
    if (parts[0] !== 'cx' || parts[1] !== 'aq') return false;
    const [, , key, action] = parts;
    const record = this.stateStore.asyncQuestion(key);
    const binding = record && this.stateStore.binding(record.threadId);
    if (!record || record.channelId !== interaction.channelId || binding?.channelId !== record.channelId
      || binding.hidden || this.stateStore.isProjectHidden?.(binding.projectKey)
      || (interaction.message && interaction.message.id !== record.messageId)) {
      throw new Error('この質問の所属タスクを確認できません。');
    }
    if (record.phase !== 'open') throw new Error('この質問は回答済み、または配送状態の確認が必要です。');
    if (action === 'write' || (action === 'select' && interaction.values?.[0] === '__other__')) {
      const input = new TextInputBuilder().setCustomId('answer').setLabel(truncate(record.title, 45, ''))
        .setStyle(TextInputStyle.Paragraph).setMaxLength(4000).setRequired(true);
      await interaction.showModal(new ModalBuilder().setCustomId(`cx:aq:${key}:answer`)
        .setTitle('Codexへの回答').addComponents(new ActionRowBuilder().addComponents(input)));
      return true;
    }
    if (['prev', 'next'].includes(action)) {
      await interaction.deferUpdate();
      const lastPage = Math.max(0, Math.ceil(record.options.length / OPTIONS_PER_PAGE) - 1);
      this.stateStore.setAsyncQuestion(key, { page: Math.min(lastPage, Math.max(0, record.page + (action === 'next' ? 1 : -1))) });
      await this.#refresh(this.stateStore.asyncQuestion(key));
      return true;
    }
    let answer;
    if (action === 'answer' && interaction.isModalSubmit()) answer = interaction.fields.getTextInputValue('answer');
    else if (action === 'select' && interaction.isStringSelectMenu()) {
      const selected = interaction.values?.[0];
      if (!/^\d+$/.test(selected ?? '') || !record.options[Number(selected)]) throw new Error('無効な選択肢です。');
      answer = record.options[Number(selected)];
    } else throw new Error('無効な質問操作です。');
    if (typeof answer !== 'string' || !answer.trim()) throw new Error('回答を入力してください。');
    await interaction.deferReply({ ephemeral: true });
    await this.#submit(key, answer, interaction);
    return true;
  }

  async #submit(key, answer, interaction) {
    let record = this.stateStore.asyncQuestion(key);
    if (record.phase !== 'open') throw new Error('別の回答を処理中です。二重送信はしません。');
    this.stateStore.setAsyncQuestion(key, { phase: 'preparing' });
    try {
      if (this.codex.recentTurns) {
        const recent = await this.codex.recentTurns(record.threadId, { limit: 2, itemsView: 'full' });
        for (const turn of recent.data ?? []) for (const item of turn.items ?? []) await this.observeReply(record, item);
      }
      if (this.stateStore.asyncQuestion(key).phase === 'answered') {
        await interaction.editReply('別のクライアントで回答済みです。再送しません。');
        return;
      }
      const target = await this.codex.prepareDelivery(record.threadId);
      if (this.stateStore.asyncQuestion(key).phase === 'answered') {
        await interaction.editReply('別のクライアントで回答済みです。再送しません。');
        return;
      }
      const clientUserMessageId = `discord-question-${key}`;
      this.stateStore.setAsyncQuestion(key, { phase: 'dispatching', target, clientUserMessageId });
      const result = await this.codex.executePreparedDelivery(record.threadId, questionReplyText(record, answer), null, clientUserMessageId, target);
      const accepted = target.mode === 'steer' ? result.result?.turnId : result.result?.turn?.id;
      if (!accepted || accepted !== result.turnId || (target.mode === 'steer' && accepted !== target.expectedTurnId)) {
        throw new Error('回答の配送先turnを確認できません。再送しません。');
      }
      this.stateStore.setAsyncQuestion(key, { phase: 'answered', acceptedTurnId: accepted, answeredBy: interaction.user.id });
      this.log('async-question-answered', { key, threadId: record.threadId, acceptedTurnId: accepted });
    } catch (error) {
      const current = this.stateStore.asyncQuestion(key);
      if (current.phase !== 'answered') {
        this.stateStore.setAsyncQuestion(key, { phase: current.phase === 'dispatching' ? 'deliveryUnknown' : 'open' });
        await this.#refresh(this.stateStore.asyncQuestion(key)).catch(() => {});
        throw error;
      }
    }
    record = this.stateStore.asyncQuestion(key);
    await this.#refresh(record).catch(() => {});
    await interaction.editReply('Codexへ回答しました。');
  }
}
