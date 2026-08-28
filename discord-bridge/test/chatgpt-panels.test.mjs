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
  splitChatgptMarkdown,
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
  assert.equal(payload.components[1].toJSON().components[0].custom_id, `cg:history:${CONVERSATION.conversationId}`);
  assert.equal(payload.components[1].toJSON().components[0].label, '最近5ターン同期');
  assert.equal(payload.components[1].toJSON().components[2].custom_id, `cg:unlink:${CONVERSATION.conversationId}`);
});

test('ChatGPT response delivery uses Markdown messages and caps long output with a complete attachment', () => {
  const payloads = chatgptResponsePayloads('x'.repeat(30_000));
  assert.equal(payloads.length, 10);
  assert.equal(payloads.at(-1).files[0].name, 'chatgpt-answer.md');
  assert.equal(payloads.at(-1).files[0].attachment.length, 30_000);
  assert.ok(payloads.every((payload) => !payload.content || payload.content.length <= 2_000));

  const short = chatgptResponsePayloads('hello');
  assert.equal(short.length, 1);
  assert.equal(short[0].content, '**ChatGPT**\nhello');
  assert.equal(short[0].embeds, undefined);
});

test('ChatGPT Markdown pages close and reopen fenced code blocks', () => {
  const chunks = splitChatgptMarkdown(`before\n\`\`\`js\n${'const value = 1;\n'.repeat(200)}\`\`\`\nafter`, 500);
  assert.ok(chunks.length > 2);
  assert.ok(chunks.every((chunk) => chunk.length <= 500));
  assert.match(chunks[0], /\n```$/);
  assert.match(chunks[1], /^```js\n/);
  assert.match(chunks.at(-1), /```\nafter$/);
});

test('ChatGPT returned-file descriptors are shown separately from answer text', () => {
  const payloads = chatgptResponsePayloads('answer', {
    assistantAttachments: [{ name: 'picture.png', mimeType: 'image/png', size: 123 }],
  });
  assert.equal(payloads[0].content, '**ChatGPT**\nanswer');
  assert.equal(payloads.length, 2);
  const fileEmbed = payloads[1].embeds[0].toJSON();
  assert.match(fileEmbed.title, /returned files \(1\)/i);
  assert.match(fileEmbed.description, /picture\.png/);
});

test('reviewer-accessor image exclusions are rejected before submission', () => {
  assert.equal(isUnsupportedChatgptImage({ name: 'photo.jpg', contentType: 'application/octet-stream' }), true);
  assert.equal(isUnsupportedChatgptImage({ name: 'payload.bin', contentType: 'image/png' }), true);
  assert.equal(isUnsupportedChatgptImage({ name: 'report.pdf', contentType: 'application/pdf' }), false);
});
