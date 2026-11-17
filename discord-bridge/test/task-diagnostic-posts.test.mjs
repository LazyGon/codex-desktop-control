import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { TaskDiagnosticPosts } from '../src/task-diagnostic-posts.mjs';
import { DiscordController } from '../src/discord-controller.mjs';
import { StateStore } from '../src/state-store.mjs';

const advisories = [
  'Codex is ignoring 1 unrecognized configuration setting. The configuration key computer_use.windows.always_allowed_app_ids is ignored.',
  'Under-development features enabled: computer_use. Under-development features are incomplete and may behave unpredictably. To suppress this warning, set `suppress_unstable_features_warning = true` in config.toml.',
  'Combined user instructions use 63830 bytes, above the 32768-byte project_doc_max_bytes setting. The total includes global and thread instructions. The limit applies only to project files.',
];
const warning = (message, threadId = 'task-a', extra = {}) => ({
  method: 'warning', params: { threadId, message, ...extra },
});

function fixture(context) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-task-diagnostics-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const stateStore = new StateStore(directory, 'guild');
  for (const id of ['task-a', 'task-b']) stateStore.setBinding(id, { channelId: `${id}-channel` });
  const sent = [];
  const create = (store = stateStore, overrides = {}) => new TaskDiagnosticPosts({
    stateStore: store,
    fetchChannel: async id => ({ id }),
    send: async (channel, content) => { sent.push([channel.id, content]); return { id: 'message' }; },
    ...overrides,
  });
  return { directory, stateStore, sent, create, binding: id => stateStore.binding(id ?? 'task-a') };
}

for (const [index, advisory] of advisories.entries()) {
  test(`advisory ${index + 1} is posted once per task across replay, resume, and reopening state`, async context => {
    const { directory, stateStore, sent, create, binding } = fixture(context);
    const posts = create();
    await posts.post(binding(), warning(advisory, 'task-a', { turnId: 'turn-one' }));
    await posts.post(binding(), warning(advisory, 'task-a', { turnId: 'turn-two' }));
    await posts.post(binding('task-b'), warning(advisory, 'task-b'));
    const reopened = new StateStore(directory, 'guild');
    await create(reopened).post(reopened.binding('task-a'), warning(advisory));
    assert.deepEqual(sent, [
      ['task-a-channel', `**warning**\n${advisory}`],
      ['task-b-channel', `**warning**\n${advisory}`],
    ]);
    assert.equal(stateStore.binding('task-a').channelId, 'task-a-channel');
  });
}

test('each advisory family retains its own latest content and changed values are visible', async context => {
  const { directory, sent, create, binding } = fixture(context);
  const posts = create();
  for (const text of advisories) await posts.post(binding(), warning(text));
  for (const text of advisories) await posts.post(binding(), warning(text));
  const changes = [
    advisories[0].replace('computer_use.windows.always_allowed_app_ids', 'other.setting'),
    advisories[1].replace('enabled: computer_use.', 'enabled: computer_use, shell.'),
    advisories[2].replace('63830', '64000'),
  ];
  for (const text of changes) await posts.post(binding(), warning(text));
  const reopened = new StateStore(directory, 'guild');
  const restarted = create(reopened);
  for (const text of changes) await restarted.post(reopened.binding('task-a'), warning(text));
  assert.deepEqual(sent.map(([, text]) => text), [...advisories, ...changes].map(text => `**warning**\n${text}`));
  assert.equal(Object.keys(reopened.binding('task-a').startupAdvisories).length, 3);
  // Only the latest content in a family is retained, rather than an unbounded history.
  await restarted.post(reopened.binding('task-a'), warning(advisories[0]));
  assert.equal(sent.at(-1)[1], `**warning**\n${advisories[0]}`);
  assert.equal(sent.length, 7);
});

test('fingerprints include content beyond the Discord display truncation', async context => {
  const { sent, create, binding } = fixture(context);
  const posts = create();
  const long = `${advisories[0]} ${'a'.repeat(1900)}`;
  await posts.post(binding(), warning(`${long} first-key`));
  await posts.post(binding(), warning(`${long} second-key`));
  assert.equal(sent.length, 2);
  assert.equal(sent[0][1], sent[1][1]);
});

test('unknown warnings, errors, and guardian warnings retain repeated delivery', async context => {
  const { stateStore, sent, create, binding } = fixture(context);
  const posts = create();
  const inputs = [
    warning('A new operational warning'),
    warning('Under-development features enabled: unexpected failure'),
    warning('Combined user instructions use invalid data'),
    { method: 'error', params: { message: advisories[0] } },
    { method: 'guardianWarning', params: { message: advisories[1] } },
    { method: 'warning', params: { detail: 'structured warning without message' } },
  ];
  for (const input of inputs) {
    await posts.post(binding(), input);
    await posts.post(binding(), input);
  }
  assert.deepEqual(sent.map(([, text]) => text), inputs.flatMap(input => {
    const text = `**${input.method}**\n${input.params.message ?? JSON.stringify(input.params)}`;
    return [text, text];
  }));
  assert.equal(stateStore.binding('task-a').startupAdvisories, undefined);
});

test('terminal errors remain on the final card and retry progress remains visible', async context => {
  const { sent, create, binding } = fixture(context);
  const posts = create();
  await posts.post(binding(), { method: 'error', params: { turnId: 'turn-a', willRetry: false, message: 'failed' } });
  await posts.post(binding(), { method: 'error', params: { turn: { id: 'turn-b' }, willRetry: false, message: 'failed' } });
  await posts.post(binding(), { method: 'error', params: { willRetry: false, message: 'startup failure' } });
  const retry = { method: 'error', params: { turnId: 'turn-a', willRetry: true, message: 'Reconnecting 2/5' } };
  await posts.post(binding(), retry);
  await posts.post(binding(), retry);
  assert.deepEqual(sent.map(([, text]) => text), [
    '**error**\nstartup failure',
    '通信エラーです。再試行中（2/5）',
    '通信エラーです。再試行中（2/5）',
  ]);
});

test('parallel same-task advisories serialize while another task proceeds', async context => {
  const { sent, create, binding } = fixture(context);
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  const posts = create(undefined, { fetchChannel: async id => {
    if (id === 'task-a-channel') { started.resolve(); await release.promise; }
    return { id };
  } });
  const first = posts.post(binding(), warning(advisories[0]));
  await started.promise;
  const duplicate = posts.post(binding(), warning(advisories[0]));
  const different = posts.post(binding(), warning(advisories[1]));
  await posts.post(binding('task-b'), warning(advisories[0], 'task-b'));
  assert.deepEqual(sent, [['task-b-channel', `**warning**\n${advisories[0]}`]]);
  release.resolve();
  await Promise.all([first, duplicate, different]);
  assert.deepEqual(sent.slice(1), advisories.slice(0, 2).map(text => ['task-a-channel', `**warning**\n${text}`]));
});

test('a missing channel makes no delivery claim and the next notification can post', async context => {
  const { directory, stateStore, sent, create, binding } = fixture(context);
  const unavailable = create(undefined, { fetchChannel: async () => { throw new Error('offline'); } });
  await unavailable.post(binding(), warning(advisories[0]));
  assert.equal(stateStore.binding('task-a').startupAdvisories, undefined);
  const reopened = new StateStore(directory, 'guild');
  await create(reopened).post(reopened.binding('task-a'), warning(advisories[0]));
  assert.deepEqual(sent, [['task-a-channel', `**warning**\n${advisories[0]}`]]);
});

test('an uncertain Discord send is durably claimed before writing and is never replayed', async context => {
  const { directory, sent, create, binding } = fixture(context);
  const uncertain = create(undefined, { send: async (channel, content) => {
    // Reopening during send proves the claim was persisted before the side effect.
    const duringSend = new StateStore(directory, 'guild');
    await create(duringSend).post(duringSend.binding('task-a'), warning(advisories[0]));
    sent.push([channel.id, content]);
    throw new Error('Discord response lost');
  } });
  const attempts = await Promise.allSettled([
    uncertain.post(binding(), warning(advisories[0])),
    uncertain.post(binding(), warning(advisories[0])),
  ]);
  assert.deepEqual(attempts.map(result => result.status), ['rejected', 'fulfilled']);
  const reopened = new StateStore(directory, 'guild');
  assert.equal(reopened.binding('task-a').startupAdvisories.unrecognizedConfiguration.outcome, 'unknown');
  await create(reopened).post(reopened.binding('task-a'), warning(advisories[0]));
  await create(reopened).post(reopened.binding('task-a'), warning(advisories[1]));
  assert.deepEqual(sent.map(([, text]) => text), advisories.slice(0, 2).map(text => `**warning**\n${text}`));
});

test('failure to persist the delivery claim prevents the Discord write', async context => {
  const { stateStore, sent, create, binding } = fixture(context);
  const unavailableStore = {
    binding: id => stateStore.binding(id),
    setBinding: () => { throw new Error('state disk unavailable'); },
  };
  await assert.rejects(create(unavailableStore).post(binding(), warning(advisories[0])), /state disk unavailable/);
  assert.deepEqual(sent, []);
});

test('a successful send with a failed outcome save keeps the durable unknown fence', async context => {
  const { directory, stateStore, sent, create, binding } = fixture(context);
  const failingOutcomeStore = {
    binding: id => stateStore.binding(id),
    setBinding: (id, patch) => {
      if (patch.startupAdvisories.unrecognizedConfiguration.outcome === 'posted') {
        throw new Error('outcome disk unavailable');
      }
      stateStore.setBinding(id, patch);
    },
  };
  await assert.rejects(create(failingOutcomeStore).post(binding(), warning(advisories[0])), /outcome disk unavailable/);
  const reopened = new StateStore(directory, 'guild');
  await create(reopened).post(reopened.binding('task-a'), warning(advisories[0]));
  assert.deepEqual(sent, [['task-a-channel', `**warning**\n${advisories[0]}`]]);
});

test('controller notifications use durable deduplication without changing normal delivery options', async context => {
  const { directory, stateStore, sent } = fixture(context);
  function controller(store) {
    const client = new EventEmitter();
    const codex = new EventEmitter();
    client.user = { id: 'bot' };
    client.channels = { fetch: async id => ({ send: async options => { sent.push([id, options]); } }) };
    const instance = new DiscordController({ client, codex, stateStore: store,
      config: { authorizedUserIds: ['owner'] }, logDir: directory });
    instance.attach();
    context.after(() => instance.stop());
    return { instance, codex };
  }
  const first = controller(stateStore);
  const emit = async (target, inputs) => {
    for (const input of inputs) target.codex.emit('notification', input);
    await Promise.all([...target.instance.notificationQueues.values()]);
  };
  await emit(first, [...advisories, ...advisories].map(text => warning(text)));
  await first.instance.stop();
  const second = controller(new StateStore(directory, 'guild'));
  await emit(second, advisories.map(text => warning(text, 'task-a', { turnId: 'resumed-turn' })));
  await emit(second, [
    warning(advisories[0], 'task-b'),
    warning('operational warning'), warning('operational warning'),
    { method: 'guardianWarning', params: { threadId: 'task-a', message: advisories[1] } },
    { method: 'error', params: { threadId: 'task-a', message: 'startup failed' } },
  ]);
  assert.deepEqual(sent, [
    ...advisories.map(text => ['task-a-channel', { content: `**warning**\n${text}`, allowedMentions: { parse: [] } }]),
    ['task-b-channel', { content: `**warning**\n${advisories[0]}`, allowedMentions: { parse: [] } }],
    ...['**warning**\noperational warning', '**warning**\noperational warning',
      `**guardianWarning**\n${advisories[1]}`, '**error**\nstartup failed'].map(content => [
      'task-a-channel', { content, allowedMentions: { parse: [] } },
    ]),
  ]);
});
