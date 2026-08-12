import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CHATGPT_COLOR,
  CHATGPT_CONTROL_PANEL_MARKER,
  chatgptControlPanelPayload,
  chatgptConversationPanelPayload,
} from '../src/chatgpt-panels.mjs';
import {
  chatgptResponsePayloads,
  isUnsupportedChatgptImage,
} from '../src/chatgpt-controller.mjs';

const CONVERSATION = {
  conversationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  name: 'Design chat',
  channelId: '123456789012345678',
  responsePerformance: 'high',
  activeMessageId: null,
};

test('ChatGPT control panel lists only explicitly persisted conversations', () => {
  const empty = chatgptControlPanelPayload({ conversations: [], ready: true });
  assert.equal(empty.embeds[0].toJSON().footer.text, CHATGPT_CONTROL_PANEL_MARKER);
  assert.match(empty.embeds[0].toJSON().description, /自動検出はせず/);
  assert.equal(empty.components.some((row) => row.toJSON().components[0].custom_id === 'cg:open'), false);

  const linked = chatgptControlPanelPayload({ conversations: [CONVERSATION], ready: true });
  assert.equal(linked.embeds[0].toJSON().color, CHATGPT_COLOR);
  const picker = linked.components.at(-1).toJSON().components[0];
  assert.equal(picker.custom_id, 'cg:open');
  assert.deepEqual(picker.options.map((option) => option.value), [CONVERSATION.conversationId]);
});

test('ChatGPT conversation panel exposes performance and confirmed unlink UI', () => {
  const payload = chatgptConversationPanelPayload(CONVERSATION);
  assert.equal(payload.embeds[0].toJSON().color, CHATGPT_COLOR);
  assert.equal(payload.components[0].toJSON().components[0].custom_id, `cg:performance:${CONVERSATION.conversationId}`);
  assert.equal(
    payload.components[0].toJSON().components[0].options.find((option) => option.default).value,
    'high',
  );
  assert.equal(payload.components[1].toJSON().components[1].custom_id, `cg:unlink:${CONVERSATION.conversationId}`);
});

test('ChatGPT response delivery is capped at five posts with a complete text attachment', () => {
  const payloads = chatgptResponsePayloads('x'.repeat(30_000));
  assert.equal(payloads.length, 5);
  assert.equal(payloads.at(-1).files[0].name, 'chatgpt-answer.txt');
  assert.equal(payloads.at(-1).files[0].attachment.length, 30_000);

  const short = chatgptResponsePayloads('hello');
  assert.equal(short.length, 1);
  assert.equal(short[0].embeds[0].toJSON().description, 'hello');
});

test('reviewer-accessor image exclusions are rejected before submission', () => {
  assert.equal(isUnsupportedChatgptImage({ name: 'photo.jpg', contentType: 'application/octet-stream' }), true);
  assert.equal(isUnsupportedChatgptImage({ name: 'payload.bin', contentType: 'image/png' }), true);
  assert.equal(isUnsupportedChatgptImage({ name: 'report.pdf', contentType: 'application/pdf' }), false);
});
