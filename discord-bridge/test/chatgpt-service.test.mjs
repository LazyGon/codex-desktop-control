import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ChatgptService,
  chatgptConversationIdentity,
  loadReviewerAccessorModules,
} from '../src/chatgpt-service.mjs';

const CONVERSATION_URL = 'https://chatgpt.com/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function fakeModules({ sendImpl = null } = {}) {
  const calls = { update: 0, accessors: 0, sends: [] };
  class Accessor {
    constructor() { calls.accessors += 1; }
    async send(options) {
      calls.sends.push(options);
      if (sendImpl) return sendImpl(options);
      options.onStatus?.({ phase: 'completed', submissionStatus: 'COMPLETED' });
      return {
        requestMessageId: 'request-1',
        assistantMessageId: 'assistant-1',
        assistantText: 'final answer',
        assistantAttachments: [],
        done: true,
      };
    }
  }
  return {
    calls,
    modules: {
      updateClient: async () => {
        calls.update += 1;
        return { status: 'current', updated: false, head: 'abc123' };
      },
      DISCORD_REVIEWER_ACCESSOR_SCHEMA_VERSION: 1,
      DiscordReviewerAccessor: Accessor,
    },
  };
}

function config() {
  return {
    reviewerAccessorRoot: 'C:\\git\\other\\reviewer-accessor',
    reviewerAccessorProfile: 'dev',
    reviewerAccessorPort: 9222,
    reviewerAccessorResponsePerformance: 'fastest',
  };
}

test('ChatGPT link identity follows the public wrapper conversation URL shape', () => {
  assert.deepEqual(
    chatgptConversationIdentity(`https://chatgpt.com/g/example/c/${CONVERSATION_URL.split('/').at(-1)}`),
    {
      conversationId: CONVERSATION_URL.split('/').at(-1),
      conversationUrl: `https://chatgpt.com/g/example/c/${CONVERSATION_URL.split('/').at(-1)}`,
    },
  );
  assert.throws(
    () => chatgptConversationIdentity(`https://example.com/c/${CONVERSATION_URL.split('/').at(-1)}`),
    /chatgpt\.com/,
  );
  assert.throws(
    () => chatgptConversationIdentity('https://chatgpt.com/'),
    /conversation ID/,
  );
});

test('ChatgptService loads reviewer-accessor once and uses only its public Discord Bridge API', async () => {
  const fake = fakeModules();
  const service = new ChatgptService({
    config: config(),
    moduleLoader: async () => fake.modules,
  });
  const status = await service.status(CONVERSATION_URL);
  assert.equal(status.transport, 'reviewer-accessor-discord-bridge');
  assert.equal(status.browserSessionCheck, 'on-send');
  assert.equal(status.profile, 'dev');
  assert.equal(status.schemaVersion, 1);

  let streamed = null;
  const result = await service.send({
    conversationUrl: CONVERSATION_URL,
    responsePerformance: 'high',
    prompt: 'hello',
    files: ['C:\\input\\report.pdf'],
    onText: (text) => { streamed = text; },
  });
  assert.equal(result.assistantText, 'final answer');
  assert.equal(streamed, 'final answer');
  assert.equal(fake.calls.update, 1);
  assert.equal(fake.calls.accessors, 1);
  assert.equal(fake.calls.sends[0].responsePerformance, 'high');
  assert.equal(fake.calls.sends[0].profile, 'dev');
  assert.deepEqual(fake.calls.sends[0].files, ['C:\\input\\report.pdf']);
  assert.equal(service.activeCount, 0);
});

test('ChatgptService rejects a second in-flight send for the same explicit conversation', async () => {
  let release;
  let started;
  const startedPromise = new Promise((resolve) => { started = resolve; });
  const fake = fakeModules({
    sendImpl: async () => {
      started();
      return new Promise((resolve) => { release = resolve; });
    },
  });
  const service = new ChatgptService({ config: config(), moduleLoader: async () => fake.modules });
  const first = service.send({ conversationUrl: CONVERSATION_URL, prompt: 'one' });
  await startedPromise;
  await assert.rejects(
    service.send({ conversationUrl: CONVERSATION_URL, prompt: 'two' }),
    /別の応答が進行中/,
  );
  release({ assistantText: 'done', assistantAttachments: [], done: true });
  await first;
  assert.equal(fake.calls.sends.length, 1);
});

test('reviewer-accessor loader resolves the canonical package export without internal transport imports', async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chatgpt-browser-native-contract-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(root, 'public-api'), { recursive: true });
  fs.writeFileSync(path.join(root, 'scripts', 'update-client.mjs'), [
    'export async function updateClient(options) {',
    "  return { status: 'current', updated: false, mode: options.mode };",
    '}',
  ].join('\n'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    exports: { './discord-bridge': './public-api/discord.mjs' },
  }));
  fs.writeFileSync(path.join(root, 'public-api', 'discord.mjs'), [
    'export const DISCORD_REVIEWER_ACCESSOR_SCHEMA_VERSION = 1;',
    'export class DiscordReviewerAccessor {}',
  ].join('\n'));

  const modules = await loadReviewerAccessorModules(root);
  assert.equal(modules.updateResult.mode, 'auto');
  assert.equal(typeof modules.DiscordReviewerAccessor, 'function');
  assert.equal(modules.DISCORD_REVIEWER_ACCESSOR_SCHEMA_VERSION, 1);
  assert.equal(fs.existsSync(path.join(root, 'transport')), false);
});
