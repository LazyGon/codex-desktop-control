import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { Client, GatewayIntentBits } from 'discord.js';
import { AppServerClient } from '../src/app-server-client.mjs';
import { dataDir, loadConfig } from '../src/config.mjs';
import { extractLocalFileReferences } from '../src/local-file-share.mjs';
import {
  completionTextFromSession,
  finalTextFromTurn,
  sanitizeChannelName,
  threadStatusEmoji,
  truncate,
} from '../src/util.mjs';

const config = loadConfig();
const token = process.env.DISCORD_BOT_TOKEN;
if (!token) throw new Error('DISCORD_BOT_TOKEN is not set.');

const state = JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'));
const runtime = JSON.parse(fs.readFileSync(path.join(dataDir, 'runtime.json'), 'utf8'));
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const codex = new AppServerClient(runtime.codex?.endpoint);
const errors = [];
const stats = {
  channels: 0,
  messages: 0,
  userMessages: 0,
  userCards: 0,
  assistantMessages: 0,
  assistantCards: 0,
  turnCards: 0,
  liveCards: 0,
  reasoningCards: 0,
  turnRecords: 0,
};

function embedIdentity(message) {
  for (const embed of message.embeds) {
    const task = embed.fields?.find((field) => field.name === 'Task')?.value?.match(/`([^`]+)`/)?.[1];
    const turn = embed.fields?.find((field) => field.name === 'Turn')?.value?.match(/`([^`]+)`/)?.[1];
    const item = embed.fields?.find((field) => field.name === 'Message')?.value?.match(/`([^`]+)`/)?.[1];
    if (task && turn) return { task, turn, item, embed };
  }
  return null;
}

function userEmbedIdentity(message) {
  for (const embed of message.embeds) {
    if (embed.title !== 'User message') continue;
    const task = embed.fields?.find((field) => field.name === 'Task')?.value?.match(/`([^`]+)`/)?.[1];
    const turn = embed.fields?.find((field) => field.name === 'Turn')?.value?.match(/`([^`]+)`/)?.[1];
    const item = embed.fields?.find((field) => field.name === 'Message')?.value?.match(/`([^`]+)`/)?.[1];
    if (task && turn && item) return { task, turn, item, embed };
  }
  return null;
}

function hasLinkedFilesButton(message) {
  return message.components.some((row) => row.components.some((component) => component.customId === 'cx:files:linked'));
}

async function fetchHistory(channel) {
  const result = new Map();
  let before;
  while (true) {
    const batch = await channel.messages.fetch({ limit: 100, before });
    if (!batch.size) break;
    for (const message of batch.values()) result.set(message.id, message);
    before = batch.last().id;
    if (batch.size < 100) break;
  }
  return result;
}

const timeout = setTimeout(() => {
  process.stderr.write('Discord transcript verification timed out after 120 seconds.\n');
  client.destroy();
  process.exitCode = 1;
}, 120_000);

try {
  await client.login(token);
  if (!client.isReady()) await new Promise((resolve) => client.once('clientReady', resolve));
  await codex.connect();
  if (state.schemaVersion !== 4) errors.push(`State schema is ${state.schemaVersion}; expected 4.`);

  const guild = await client.guilds.fetch(config.guildId);
  for (const [threadId, binding] of Object.entries(state.bindings ?? {})) {
    stats.channels += 1;
    if (binding.transcriptVersion !== 11) errors.push(`${threadId}: transcriptVersion is not 11.`);
    if (!binding.projectId) errors.push(`${threadId}: projectId is missing.`);
    const channel = await guild.channels.fetch(binding.channelId).catch(() => null);
    if (!channel?.isTextBased()) {
      errors.push(`${threadId}: task channel ${binding.channelId} is unavailable.`);
      continue;
    }
    const expectedName = `${threadStatusEmoji({ type: binding.taskStatus })}-${sanitizeChannelName(binding.name ?? threadId.slice(0, 8))}`;
    if (channel.name !== expectedName) errors.push(`${threadId}: channel name ${channel.name} does not match ${expectedName}.`);
    const expectedTurnState = binding.taskStatus === 'active' ? 'running' : 'stopped';
    if (!channel.topic?.includes(`Codex project: ${binding.projectId}`)
      || !channel.topic?.includes(`Codex task: ${threadId}`)
      || !channel.topic?.includes(`Turn: ${expectedTurnState}`)) {
      errors.push(`${threadId}: channel topic does not contain the project/task/turn state.`);
    }

    const messages = await fetchHistory(channel);
    const { thread } = await codex.call('thread/read', { threadId, includeTurns: true }, 60_000);
    if (thread.name && binding.name !== thread.name) {
      errors.push(`${threadId}: binding name ${binding.name} does not match Codex task name ${thread.name}.`);
    }
    const turnsById = new Map((thread.turns ?? []).map((turn) => [turn.id, turn]));
    const activeTurnIds = new Set((thread.turns ?? [])
      .filter((turn) => turn.status === 'inProgress')
      .map((turn) => turn.id));
    stats.messages += messages.size;
    const cardIds = new Set();
    const assistantCardIds = new Set();
    const userCardIds = new Set();
    const finalIdentities = new Map();
    const assistantIdentities = new Map();
    const userIdentities = new Map();
    let channelLiveCards = 0;
    for (const [turnId, record] of Object.entries(binding.turnMessages ?? {})) {
      stats.turnRecords += 1;
      const turn = turnsById.get(turnId);
      const expectedUsers = new Map((turn?.items ?? [])
        .filter((item) => item.type === 'userMessage')
        .map((item, index) => [item.id ?? `user-${index + 1}`, (item.content ?? [])
          .map((part) => part.text ?? '').filter(Boolean).join('\n')]));
      for (const [itemId, entry] of Object.entries(record.userEntries ?? {})) {
        if (!expectedUsers.has(itemId) && entry.text) expectedUsers.set(itemId, entry.text);
      }
      for (const [itemId, expectedText] of expectedUsers) {
        const entry = record.userEntries?.[itemId];
        if (!entry) {
          errors.push(`${threadId}/${turnId}/${itemId}: user card entry is missing.`);
          continue;
        }
        if (entry.messageIds?.length !== 1) {
          errors.push(`${threadId}/${turnId}/${itemId}: user entry does not point to exactly one card.`);
          continue;
        }
        const messageId = entry.messageIds[0];
        userCardIds.add(messageId);
        const card = messages.get(messageId);
        if (!card) {
          errors.push(`${threadId}/${turnId}/${itemId}: user card ${messageId} is missing.`);
          continue;
        }
        const identity = userEmbedIdentity(card);
        if (!identity || identity.task !== threadId || identity.turn !== turnId || identity.item !== itemId) {
          errors.push(`${threadId}/${turnId}/${itemId}: user card identity is invalid.`);
        }
        const value = String(expectedText).trim() || '(empty)';
        if (card.embeds[0]?.description !== truncate(value, 3900)) {
          errors.push(`${threadId}/${turnId}/${itemId}: user card message does not match app-server state.`);
        }
        if (value.length > 3900 && !card.attachments.size) {
          errors.push(`${threadId}/${turnId}/${itemId}: long user card has no full-text attachment.`);
        }
        const attachmentNames = [...card.attachments.values()].map((attachment) => attachment.name);
        const duplicateAttachmentNames = attachmentNames.filter((name, index) => attachmentNames.indexOf(name) !== index);
        if (duplicateAttachmentNames.length) {
          errors.push(`${threadId}/${turnId}/${itemId}: user card has duplicate attachments: ${[...new Set(duplicateAttachmentNames)].join(', ')}.`);
        }
        const fullTextName = `codex-turn-${turnId}-${itemId}-user.txt`;
        const fullTextAttachments = attachmentNames.filter((name) => name === fullTextName).length;
        if (value.length > 3900 && fullTextAttachments !== 1) {
          errors.push(`${threadId}/${turnId}/${itemId}: long user card has ${fullTextAttachments} full-text attachments.`);
        }
        if (value.length <= 3900 && fullTextAttachments) {
          errors.push(`${threadId}/${turnId}/${itemId}: short user card has a full-text attachment.`);
        }
      }
      for (const id of record.userMessageIds ?? []) {
        stats.userMessages += 1;
        if (!messages.has(id)) errors.push(`${threadId}/${turnId}: user message ${id} is missing.`);
      }
      const commentaryById = new Map((turn?.items ?? [])
        .filter((item) => item.type === 'agentMessage' && item.phase === 'commentary' && item.text)
        .map((item) => [item.id, item]));
      if (record.status !== 'inProgress') {
        for (const [itemId, entry] of Object.entries(record.assistantEntries ?? {})) {
        const item = commentaryById.get(itemId)
          ?? (entry.text ? { id: itemId, phase: entry.phase ?? 'commentary', text: entry.text } : null);
        if (!item) {
          errors.push(`${threadId}/${turnId}/${itemId}: assistant ledger entry has no recoverable commentary text.`);
          continue;
        }
        if (entry.messageIds?.length !== 1) {
          errors.push(`${threadId}/${turnId}/${itemId}: assistant entry does not point to exactly one card.`);
          continue;
        }
        const messageId = entry.messageIds[0];
        assistantCardIds.add(messageId);
        stats.assistantMessages += 1;
        const card = messages.get(messageId);
        if (!card) {
          errors.push(`${threadId}/${turnId}/${itemId}: assistant card ${messageId} is missing.`);
          continue;
        }
        const identity = embedIdentity(card);
        if (!identity || identity.task !== threadId || identity.turn !== turnId || identity.item !== itemId) {
          errors.push(`${threadId}/${turnId}/${itemId}: assistant card identity is invalid.`);
        }
        const expectedTitle = 'Codex message';
        if (card.embeds[0]?.title !== expectedTitle) {
          errors.push(`${threadId}/${turnId}/${itemId}: assistant card title is not ${expectedTitle}.`);
        }
        const value = String(item.text).trim() || '(empty)';
        if (card.embeds[0]?.description !== truncate(value, 3900)) {
          errors.push(`${threadId}/${turnId}/${itemId}: past assistant card does not match app-server state.`);
        }
        const expectedLocalFiles = extractLocalFileReferences(value);
        if (hasLinkedFilesButton(card) !== (expectedLocalFiles.length > 0)) {
          errors.push(`${threadId}/${turnId}/${itemId}: assistant card linked-file button does not match its text.`);
        }
        const attachmentNames = [...card.attachments.values()].map((attachment) => attachment.name);
        const fullTextName = `codex-turn-${turnId}-${itemId}-assistant.txt`;
        const fullTextAttachments = attachmentNames.filter((name) => name === fullTextName).length;
        if (value.length > 3900 && fullTextAttachments !== 1) {
          errors.push(`${threadId}/${turnId}/${itemId}: long assistant card has ${fullTextAttachments} full-text attachments.`);
        }
        if (value.length <= 3900 && card.attachments.size) {
          errors.push(`${threadId}/${turnId}/${itemId}: short assistant card has an unexpected attachment.`);
        }
        }
      }
      if (record.status !== 'inProgress') {
        const ledgerAssistantIds = [...new Set(Object.values(record.assistantEntries ?? {})
          .flatMap((entry) => entry.messageIds ?? []))].sort();
        const indexedAssistantIds = [...new Set(record.assistantMessageIds ?? [])].sort();
        if (JSON.stringify(ledgerAssistantIds) !== JSON.stringify(indexedAssistantIds)) {
          errors.push(`${threadId}/${turnId}: assistantMessageIds does not match assistantEntries.`);
        }
        if (ledgerAssistantIds.length !== Object.keys(record.assistantEntries ?? {}).length) {
          errors.push(`${threadId}/${turnId}: assistant entries do not have one unique Discord card each.`);
        }
      }
      if (!record.cardMessageId) {
        errors.push(`${threadId}/${turnId}: cardMessageId is missing.`);
        continue;
      }
      cardIds.add(record.cardMessageId);
      if (!messages.has(record.cardMessageId)) errors.push(`${threadId}/${turnId}: card ${record.cardMessageId} is missing.`);
      if (record.status !== 'inProgress' && record.liveMessageId) {
        errors.push(`${threadId}/${turnId}: completed turn still has a liveMessageId.`);
      }
      if (record.status !== 'inProgress'
        && (record.finalMessageIds?.length !== 1 || record.finalMessageIds[0] !== record.cardMessageId)) {
        errors.push(`${threadId}/${turnId}: completed turn does not point finalMessageIds at its single card.`);
      }
      if (record.status !== 'inProgress') {
        const turn = turnsById.get(turnId);
          if (turn) {
          const expectedText = finalTextFromTurn(
            turn,
            completionTextFromSession(thread.path, turnId),
          ) || turn.error?.message || 'このターンにはassistantメッセージが記録されていません。';
          const card = messages.get(record.cardMessageId);
          const actualText = card?.embeds[0]?.description ?? '';
          if (actualText !== truncate(expectedText, 3900)) {
            errors.push(`${threadId}/${turnId}: past card message does not match the authoritative completion text.`);
          }
          const expectedLocalFiles = extractLocalFileReferences(expectedText);
          if (card && hasLinkedFilesButton(card) !== (expectedLocalFiles.length > 0)) {
            errors.push(`${threadId}/${turnId}: final card linked-file button does not match its text.`);
          }
          const attachmentNames = [...(card?.attachments.values() ?? [])].map((attachment) => attachment.name);
          const duplicateAttachmentNames = attachmentNames.filter((name, index) => attachmentNames.indexOf(name) !== index);
          if (duplicateAttachmentNames.length) {
            errors.push(`${threadId}/${turnId}: past card has duplicate attachments: ${[...new Set(duplicateAttachmentNames)].join(', ')}.`);
          }
          const fullTextName = `codex-turn-${turnId}-final.txt`;
          const fullTextAttachments = attachmentNames.filter((name) => name === fullTextName).length;
          if (expectedText.length > 3900 && !card?.attachments.size) {
            errors.push(`${threadId}/${turnId}: long past card message has no full-text attachment.`);
          }
          if (expectedText.length > 3900 && fullTextAttachments !== 1) {
            errors.push(`${threadId}/${turnId}: long past card has ${fullTextAttachments} full-text attachments.`);
          }
          if (expectedText.length <= 3900 && card?.attachments.size) {
            errors.push(`${threadId}/${turnId}: short past card message has an unexpected attachment.`);
          }
        }
      }
    }

    for (const message of messages.values()) {
      if (config.allowedUserIds.includes(message.author.id)) {
        errors.push(`${threadId}: raw Discord user message remains at ${message.id}.`);
      }
      if (message.author.id !== client.user.id) continue;
      if (message.content.includes('Message: user') && message.content.includes('Turn ID: `')) {
        errors.push(`${threadId}: legacy plain user message remains at ${message.id}.`);
      }
      if (message.content.includes('Message: final') && message.content.includes('Turn ID: `')) {
        errors.push(`${threadId}: legacy plain final message remains at ${message.id}.`);
      }
      if (message.embeds.some((embed) => embed.title === 'User instruction')) {
        errors.push(`${threadId}: legacy user card remains at ${message.id}.`);
      }
      const userIdentity = userEmbedIdentity(message);
      if (userIdentity) {
        stats.userCards += 1;
        const key = `${userIdentity.turn}:${userIdentity.item}`;
        if (userIdentity.task !== threadId) errors.push(`${threadId}: user card ${message.id} names task ${userIdentity.task}.`);
        if (userIdentities.has(key)) {
          errors.push(`${threadId}: duplicate user cards for ${key}: ${userIdentities.get(key)}, ${message.id}.`);
        }
        userIdentities.set(key, message.id);
        if (!userCardIds.has(message.id)) errors.push(`${threadId}: user card ${message.id} is absent from the turn ledger.`);
        const fieldNames = userIdentity.embed.fields.map((field) => field.name);
        if (JSON.stringify(fieldNames) !== JSON.stringify(['Task', 'Turn', 'Message'])) {
          errors.push(`${threadId}/${key}: user card has extra fields: ${fieldNames.join(', ')}.`);
        }
        if (userIdentity.embed.color !== 0xe67e22) {
          errors.push(`${threadId}/${key}: user card color is ${userIdentity.embed.color}; expected 0xe67e22.`);
        }
        if (userIdentity.embed.timestamp || userIdentity.embed.footer || userIdentity.embed.author) {
          errors.push(`${threadId}/${key}: user card has extra timestamp/footer/author metadata.`);
        }
        continue;
      }
      const identity = embedIdentity(message);
      if (!identity) continue;
      if (identity.task !== threadId) errors.push(`${threadId}: card ${message.id} names task ${identity.task}.`);
      if (identity.embed.title === 'Codex message') {
        stats.assistantCards += 1;
        const key = `${identity.turn}:${identity.item}`;
        if (!identity.item) errors.push(`${threadId}: assistant card ${message.id} has no Message identity.`);
        if (assistantIdentities.has(key)) {
          errors.push(`${threadId}: duplicate assistant cards for ${key}: ${assistantIdentities.get(key)}, ${message.id}.`);
        }
        assistantIdentities.set(key, message.id);
        if (!assistantCardIds.has(message.id) && !activeTurnIds.has(identity.turn)) {
          errors.push(`${threadId}: assistant card ${message.id} is absent from the turn ledger.`);
        }
        const fieldNames = identity.embed.fields.map((field) => field.name);
        if (JSON.stringify(fieldNames) !== JSON.stringify(['Task', 'Turn', 'Message'])) {
          errors.push(`${threadId}/${key}: assistant card has extra fields: ${fieldNames.join(', ')}.`);
        }
        if (identity.embed.color !== 0x5865f2) {
          errors.push(`${threadId}/${key}: assistant card color is ${identity.embed.color}; expected 0x5865f2.`);
        }
        if (identity.embed.timestamp || identity.embed.footer || identity.embed.author) {
          errors.push(`${threadId}/${key}: assistant card has extra timestamp/footer/author metadata.`);
        }
        continue;
      }
      if (identity.embed.title === 'Codex running') {
        stats.turnCards += 1;
        channelLiveCards += 1;
        stats.liveCards += 1;
        if (!cardIds.has(message.id) && !activeTurnIds.has(identity.turn)) {
          errors.push(`${threadId}: live card ${message.id} is absent from the turn ledger.`);
        }
        if (identity.item && assistantCardIds.has(message.id)) {
          stats.assistantCards += 1;
          const key = `${identity.turn}:${identity.item}`;
          if (assistantIdentities.has(key)) {
            errors.push(`${threadId}: duplicate assistant cards for ${key}: ${assistantIdentities.get(key)}, ${message.id}.`);
          }
          assistantIdentities.set(key, message.id);
        }
        const fieldNames = identity.embed.fields.map((field) => field.name);
        if (JSON.stringify(fieldNames.slice(0, 4)) !== JSON.stringify(['Task', 'Turn', 'Message', 'Elapsed'])) {
          errors.push(`${threadId}/${identity.turn}: live card identity fields are invalid: ${fieldNames.join(', ')}.`);
        }
        const reasoningField = identity.embed.fields.find((field) => field.name === 'Reasoning');
        if (reasoningField) stats.reasoningCards += 1;
        continue;
      }
      if (/^Codex turn /.test(identity.embed.title ?? '')) {
        stats.turnCards += 1;
        if (finalIdentities.has(identity.turn)) {
          errors.push(`${threadId}: duplicate final cards for turn ${identity.turn}: ${finalIdentities.get(identity.turn)}, ${message.id}.`);
        }
        finalIdentities.set(identity.turn, message.id);
        if (!cardIds.has(message.id)) errors.push(`${threadId}: final card ${message.id} is absent from the turn ledger.`);
        const fieldNames = identity.embed.fields.map((field) => field.name);
        if (JSON.stringify(fieldNames) !== JSON.stringify(['Task', 'Turn'])) {
          errors.push(`${threadId}/${identity.turn}: final card has extra fields: ${fieldNames.join(', ')}.`);
        }
        if (identity.embed.timestamp || identity.embed.footer || identity.embed.author) {
          errors.push(`${threadId}/${identity.turn}: final card has extra timestamp/footer/author metadata.`);
        }
        if (!identity.embed.description) errors.push(`${threadId}/${identity.turn}: final card message is empty.`);
      }
    }
    if (channelLiveCards > 1) errors.push(`${threadId}: ${channelLiveCards} live cards remain; expected at most one.`);
    if (binding.archived && channelLiveCards) errors.push(`${threadId}: archived task still has a live card.`);
  }

  for (const [projectKey, project] of Object.entries(state.projectCategories ?? {})) {
    if (!project.projectId) errors.push(`${projectKey}: projectId is missing.`);
    for (const categoryId of project.categoryIds ?? []) {
      const category = await guild.channels.fetch(categoryId).catch(() => null);
      if (!category) errors.push(`${projectKey}: project category ${categoryId} is unavailable.`);
    }
  }

  process.stdout.write(`${JSON.stringify({ ok: errors.length === 0, stats, errors }, null, 2)}\n`);
  if (errors.length) process.exitCode = 1;
} finally {
  clearTimeout(timeout);
  codex.close();
  client.destroy();
}
