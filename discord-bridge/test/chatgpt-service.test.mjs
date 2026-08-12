import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatgptService } from '../src/chatgpt-service.mjs';

const CONVERSATION_URL = 'https://chatgpt.com/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function fakeModules({ sendImpl = null } = {}) {
  const calls = { update: 0, migrate: 0, clients: [], sends: [] };
  const session = {
    savedAt: Date.now(),
    auth: { testFixture: true },
    integrity: { expiresAt: Date.now() + 60_000 },
    conversation: { id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' },
  };
  class Cache {
    constructor(options) { this.options = options; }
    async read() { return session; }
  }
  class Client {
    constructor(options) {
      this.options = options;
      calls.clients.push(options);
    }

    async send(prompt, options) {
      calls.sends.push({ prompt, options });
      if (sendImpl) return sendImpl(prompt, options);
      options.onText?.('streamed answer');
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
      migrateLegacyRuntime: async () => {
        calls.migrate += 1;
        return { paths: { runtimeRoot: 'C:\\runtime', cachePath: 'C:\\runtime\\cache.json' } };
      },
      loadDirectConfig: async () => ({ conversationUrl: CONVERSATION_URL, responsePerformance: null }),
      DpapiCredentialCache: Cache,
      ChatDirectClient: Client,
      validateConversationUrl: (value) => ({
        conversationId: String(value).split('/').at(-1),
        url: new URL(value),
      }),
      authIsFresh: () => true,
      integrityIsFresh: () => true,
      conversationStateIsUsable: () => true,
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

test('ChatgptService loads and updates reviewer-accessor once and uses its public client API', async () => {
  const fake = fakeModules();
  const service = new ChatgptService({
    config: config(),
    moduleLoader: async () => fake.modules,
  });
  const status = await service.status(CONVERSATION_URL);
  assert.equal(status.authFresh, true);
  assert.equal(status.conversationStateUsable, true);

  let streamed = null;
  const result = await service.send({
    conversationUrl: CONVERSATION_URL,
    responsePerformance: 'high',
    prompt: 'hello',
    files: ['C:\\input\\report.pdf'],
    onText: (text) => { streamed = text; },
  });
  assert.equal(result.assistantText, 'final answer');
  assert.equal(streamed, 'streamed answer');
  assert.equal(fake.calls.update, 1);
  assert.equal(fake.calls.migrate, 1);
  assert.equal(fake.calls.clients[0].responsePerformance, 'high');
  assert.deepEqual(fake.calls.sends[0].options.files, ['C:\\input\\report.pdf']);
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
