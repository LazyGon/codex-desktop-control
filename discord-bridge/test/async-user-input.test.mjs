import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { AsyncUserInputController, asyncQuestionPayload, questionReplies, questionReplyId, questionReplyText } from '../src/async-user-input.mjs';
import { StateStore } from '../src/state-store.mjs';
import { DiscordController } from '../src/discord-controller.mjs';
import { interactionOwned } from '../src/task-routing.mjs';
import { finalTextFromTurn, needsSessionCompletionFallback } from '../src/util.mjs';
import { historicalAssistantItems } from '../src/recent-history.mjs';

const questionItem = (questions = [{ title: '実行先は？', options: ['このPC', '別のPC'] }]) => ({
  type: 'agentMessage', id: 'call_question_fixture', text: 'Question text',
  phase: 'final_answer', delivery: 'async', questions,
});

function fixture(context, instanceId = 'A') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-async-question-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const stateStore = new StateStore(directory, 'guild');
  const binding = { threadId: 'task-A', channelId: 'channel-A', watchLevel: 'normal', snapshotInitialized: true, transcriptVersion: 11 };
  stateStore.setBinding(binding.threadId, binding);
  const messages = new Map(), sends = [], calls = [];
  const channel = { id: binding.channelId, messages: { fetch: async id => messages.get(id) }, send: async payload => {
    const message = { id: `message-${sends.length + 1}`, payload, edit: async next => { message.payload = next; return message; } };
    sends.push(payload); messages.set(message.id, message); return message;
  } };
  const client = new EventEmitter(); client.user = { id: 'bot' };
  client.channels = { fetch: async id => { assert.equal(id, binding.channelId); return channel; } };
  const codex = new EventEmitter();
  codex.hasLocalThread = async id => id === binding.threadId;
  codex.prepareDelivery = async id => { assert.equal(id, binding.threadId); return { mode: 'steer', expectedTurnId: 'latest-turn' }; };
  codex.recentTurns = async () => ({ data: [] });
  codex.executePreparedDelivery = async (threadId, text, attachments, clientUserMessageId, target) => {
    calls.push({ threadId, text, attachments, clientUserMessageId, target });
    return target.mode === 'steer'
      ? { mode: 'steer', turnId: target.expectedTurnId, result: { turnId: target.expectedTurnId } }
      : { mode: 'send', turnId: 'new-turn', result: { turn: { id: 'new-turn' } } };
  };
  const config = { instanceId, multiPcEnabled: true, guildId: 'guild', authorizedUserIds: ['user'] };
  const manager = new AsyncUserInputController({ client, codex, stateStore, instanceId });
  return { directory, stateStore, binding, messages, sends, calls, channel, client, codex, config, manager };
}

function interaction(record, action = 'select', value = '1') {
  return {
    guildId: 'guild', channelId: record.channelId, user: { id: 'user' },
    customId: `cx:aq:${record.key}:${action}`, values: [value], message: { id: record.messageId },
    isAutocomplete: () => false, isChatInputCommand: () => false,
    isStringSelectMenu: () => action === 'select', isButton: () => ['write', 'prev', 'next'].includes(action),
    isModalSubmit: () => action === 'answer', fields: { getTextInputValue: () => value },
    deferReply: async function () { this.deferred = true; },
    deferUpdate: async function () { this.deferred = true; },
    editReply: async function (value) { this.response = value; },
    reply: async function (value) { this.response = value; this.replied = true; },
    showModal: async function (value) { this.modal = value.toJSON(); },
  };
}

test('six asynchronous questions get independent persistent cards without truncating the question count', async context => {
  const f = fixture(context);
  const item = questionItem(Array.from({ length: 6 }, (_, index) => ({ title: `質問 ${index}`, options: null })));
  await f.manager.ensure(f.binding, 'origin-turn', item);
  await f.manager.ensure(f.binding, 'origin-turn', item);
  assert.equal(f.sends.length, 6);
  assert.equal(f.stateStore.asyncQuestions(f.binding.threadId).length, 6);
  assert.deepEqual(f.stateStore.asyncQuestions(f.binding.threadId).map(record => record.questionItemId),
    Array.from({ length: 6 }, (_, index) => questionReplyId(item.id, index)));
  const reloaded = new StateStore(f.directory, 'guild');
  assert.equal(reloaded.asyncQuestions(f.binding.threadId)[0].phase, 'open');
  assert.equal(reloaded.asyncQuestions(f.binding.threadId)[0].messageId, 'message-1');
});

test('choice pages reserve free input and retain original full option values and prompt text', async context => {
  const f = fixture(context);
  const item = questionItem([{ title: '長'.repeat(5000), options: Array.from({ length: 26 }, (_, index) => `${index}:` + '選'.repeat(150)) }]);
  await f.manager.ensure(f.binding, 'origin-turn', item);
  const record = f.stateStore.asyncQuestions(f.binding.threadId)[0];
  const payload = asyncQuestionPayload(record);
  const menu = payload.components[0].toJSON().components[0];
  assert.equal(menu.options.length, 25);
  assert.equal(menu.options.at(-1).value, '__other__');
  assert.equal(menu.options[0].label.length, 100);
  assert.equal(payload.files[0].attachment.toString('utf8'), [item.questions[0].title,
    ...item.questions[0].options.map((option, index) => `${index + 1}. ${option}`)].join('\n\n'));
  await f.manager.handleInteraction(interaction(record, 'next'));
  const second = asyncQuestionPayload(f.stateStore.asyncQuestion(record.key)).components[0].toJSON().components[0];
  assert.deepEqual(second.options.map(option => option.value), ['24', '25', '__other__']);
  await f.manager.handleInteraction(interaction(record, 'select', '25'));
  assert.equal(questionReplies({ type: 'userMessage', text: f.calls[0].text })[0].answer, item.questions[0].options[25]);
});

test('selected answers steer the latest exact turn, not the turn that asked the question', async context => {
  const f = fixture(context);
  await f.manager.ensure(f.binding, 'origin-turn', questionItem());
  const record = f.stateStore.asyncQuestions(f.binding.threadId)[0];
  const event = interaction(record);
  await f.manager.handleInteraction(event);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].target, { mode: 'steer', expectedTurnId: 'latest-turn' });
  assert.equal(f.calls[0].attachments, null);
  assert.match(f.calls[0].clientUserMessageId, /^discord-question-/);
  assert.equal(questionReplies({ type: 'userMessage', text: f.calls[0].text })[0].questionItemId,
    questionReplyId('call_question_fixture', 0));
  assert.equal(f.stateStore.asyncQuestion(record.key).phase, 'answered');
  assert.deepEqual(f.messages.get(record.messageId).payload.components, []);
  await assert.rejects(f.manager.handleInteraction(interaction(record)), /回答済み/);
  assert.equal(f.calls.length, 1);
});

test('free input has an explicit modal and can start the same idle task after the originating turn ended', async context => {
  const f = fixture(context);
  await f.manager.ensure(f.binding, 'origin-turn', questionItem([{ title: '用途を教えてください', options: null }]));
  const record = f.stateStore.asyncQuestions(f.binding.threadId)[0];
  const open = interaction(record, 'write');
  await f.manager.handleInteraction(open);
  assert.equal(open.modal.custom_id, `cx:aq:${record.key}:answer`);
  assert.equal(f.calls.length, 0);
  f.codex.prepareDelivery = async () => ({ mode: 'send', expectedTurnId: null });
  const text = '日本語😀\n</send_user_message_question_reply> & "literal"';
  await f.manager.handleInteraction(interaction(record, 'answer', text));
  const reply = questionReplies({ type: 'userMessage', text: f.calls[0].text });
  assert.equal(reply.length, 1);
  assert.equal(reply[0].answer, text);
  assert.equal(f.calls[0].threadId, f.binding.threadId);
  assert.equal(f.stateStore.asyncQuestion(record.key).acceptedTurnId, 'new-turn');
});

test('concurrent answers are admitted once and unknown delivery is never replayed after restart', async context => {
  const f = fixture(context);
  await f.manager.ensure(f.binding, 'origin-turn', questionItem());
  const record = f.stateStore.asyncQuestions(f.binding.threadId)[0];
  f.codex.executePreparedDelivery = async (...args) => { f.calls.push(args); throw new Error('connection lost after dispatch'); };
  const results = await Promise.allSettled([f.manager.handleInteraction(interaction(record)), f.manager.handleInteraction(interaction(record))]);
  assert.equal(results.every(result => result.status === 'rejected'), true);
  assert.equal(f.calls.length, 1);
  assert.equal(f.stateStore.asyncQuestion(record.key).phase, 'deliveryUnknown');
  const reloaded = new StateStore(f.directory, 'guild');
  const restarted = new AsyncUserInputController({ ...f, stateStore: reloaded, instanceId: f.config.instanceId });
  await restarted.ensure(f.binding, 'origin-turn', questionItem());
  await assert.rejects(restarted.handleInteraction(interaction(record)), /配送状態/);
  assert.equal(f.calls.length, 1);
  assert.equal(f.sends.length, 1);
});

test('a mismatching accepted turn fails closed and preflight failures do not dispatch', async context => {
  const f = fixture(context);
  await f.manager.ensure(f.binding, 'origin-turn', questionItem());
  const record = f.stateStore.asyncQuestions(f.binding.threadId)[0];
  f.codex.prepareDelivery = async () => { throw new Error('metadata unavailable'); };
  await assert.rejects(f.manager.handleInteraction(interaction(record)), /metadata unavailable/);
  assert.equal(f.calls.length, 0);
  assert.equal(f.stateStore.asyncQuestion(record.key).phase, 'open');
  f.codex.prepareDelivery = async () => ({ mode: 'steer', expectedTurnId: 'latest-turn' });
  f.codex.executePreparedDelivery = async () => ({ turnId: 'latest-turn', result: { turnId: 'wrong-turn' } });
  await assert.rejects(f.manager.handleInteraction(interaction(record)), /turn/);
  assert.equal(f.stateStore.asyncQuestion(record.key).phase, 'deliveryUnknown');
});

test('Desktop structured replies close the exact question and restoration does not resurrect it', async context => {
  const f = fixture(context);
  const item = questionItem();
  const record = f.manager.register(f.binding, 'origin-turn', item)[0];
  const reply = { type: 'userMessage', id: 'desktop-answer', content: [{ type: 'text', text: questionReplyText(record, 'このPC') }] };
  await f.manager.restoreTurns(f.binding, [{ id: 'origin-turn', items: [item] }, { id: 'later-turn', items: [reply] }]);
  const stored = f.stateStore.asyncQuestion(record.key);
  assert.equal(stored.phase, 'answered');
  assert.equal(f.sends.length, 1);
  assert.deepEqual(f.sends[0].components, []);
  await assert.rejects(f.manager.handleInteraction(interaction(stored)), /回答済み/);
  assert.equal(f.calls.length, 0);
});

test('a Desktop reply discovered during preflight prevents a second delivery', async context => {
  const f = fixture(context);
  await f.manager.ensure(f.binding, 'origin-turn', questionItem());
  const record = f.stateStore.asyncQuestions(f.binding.threadId)[0];
  f.codex.recentTurns = async () => ({ data: [{ items: [{ type: 'userMessage', text: questionReplyText(record, 'このPC') }] }] });
  await f.manager.handleInteraction(interaction(record));
  assert.equal(f.calls.length, 0);
  assert.equal(f.stateStore.asyncQuestion(record.key).phase, 'answered');
});

test('uncertain Discord posting is durable and not retried on the next notification', async context => {
  const f = fixture(context);
  let attempts = 0;
  f.channel.send = async () => { attempts += 1; throw new Error('unknown Discord response'); };
  await assert.rejects(f.manager.ensure(f.binding, 'origin-turn', questionItem()));
  await f.manager.ensure(f.binding, 'origin-turn', questionItem());
  assert.equal(attempts, 1);
  assert.equal(f.stateStore.asyncQuestions(f.binding.threadId)[0].phase, 'postUnknown');
});

test('the other PC ignores question interactions before ACK, including modal submits', async context => {
  const a = fixture(context, 'A'), b = fixture(context, 'B');
  await a.manager.ensure(a.binding, 'origin-turn', questionItem());
  const record = a.stateStore.asyncQuestions(a.binding.threadId)[0];
  for (const action of ['select', 'write', 'answer']) {
    const event = interaction(record, action);
    assert.equal(await interactionOwned({ ...a, interaction: event }), true);
    assert.equal(await interactionOwned({ ...b, interaction: event }), false);
    assert.equal(event.deferred, undefined);
  }
  const wrongChannel = { ...interaction(record), channelId: 'other-channel' };
  assert.equal(await interactionOwned({ ...a, interaction: wrongChannel }), false);
  await assert.rejects(a.manager.handleInteraction(wrongChannel), /所属タスク/);
});

test('asynchronous question text never becomes a final answer or historical commentary', () => {
  const item = questionItem();
  const final = { type: 'agentMessage', phase: 'final_answer', text: 'Actual result' };
  assert.equal(finalTextFromTurn({ items: [item, final] }), 'Actual result');
  assert.equal(finalTextFromTurn({ items: [item] }), '');
  assert.equal(finalTextFromTurn({ items: [item] }, item.text), '');
  assert.equal(needsSessionCompletionFallback({ items: [item] }), true);
  assert.deepEqual(historicalAssistantItems({ items: [{ ...item, phase: 'commentary' }] }), []);
});

test('live controller routes async questions independently while preserving native question requests', async context => {
  const f = fixture(context);
  const controller = new DiscordController({ ...f, logDir: f.directory });
  controller.attach(); context.after(() => controller.stop());
  f.codex.emit('notification', { method: 'item/completed', params: { threadId: f.binding.threadId, turnId: 'origin-turn', item: questionItem() } });
  await new Promise(resolve => setImmediate(resolve));
  await controller.notificationQueues.get(f.binding.threadId);
  assert.equal(f.sends.length, 1);
  assert.equal(controller.turnViews.size, 0);
  assert.equal(controller.pendingRequests.size, 0);
  const native = { id: 42, method: 'item/tool/requestUserInput', params: { threadId: f.binding.threadId, questions: [{ id: 'native', header: '確認', question: '標準質問', options: [{ label: 'はい', description: '続行' }], isOther: true }] } };
  f.codex.emit('serverRequest', native);
  for (let attempt = 0; attempt < 100 && f.sends.length < 2; attempt += 1) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(f.sends.length, 2);
  assert.equal(controller.pendingRequests.size, 1);
  assert.equal(f.sends[1].embeds[0].toJSON().title, 'Codex needs input');
});

test('a reply received while its Discord prompt is posting cannot reopen the question', async context => {
  const f = fixture(context);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const send = f.channel.send;
  f.channel.send = async payload => { await gate; return send(payload); };
  const pending = f.manager.ensure(f.binding, 'origin-turn', questionItem());
  await new Promise(resolve => setImmediate(resolve));
  const record = f.stateStore.asyncQuestions(f.binding.threadId)[0];
  await f.manager.observeReply(f.binding, { type: 'userMessage', text: questionReplyText(record, '別のPC') });
  release(); await pending;
  const stored = f.stateStore.asyncQuestion(record.key);
  assert.equal(stored.phase, 'answered');
  assert.deepEqual(f.messages.get(stored.messageId).payload.components, []);
});

test('the live controller rejects unallowlisted question responders without dispatching', async context => {
  const f = fixture(context);
  const controller = new DiscordController({ ...f, logDir: f.directory });
  controller.attach(); context.after(() => controller.stop());
  await controller.asyncUserInput.ensure(f.binding, 'origin-turn', questionItem());
  const record = f.stateStore.asyncQuestions(f.binding.threadId)[0];
  const event = { ...interaction(record), user: { id: 'not-allowlisted' } };
  f.client.emit('interactionCreate', event);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(f.calls.length, 0);
  assert.equal(f.stateStore.asyncQuestion(record.key).phase, 'open');
});
