import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StateStore } from '../src/state-store.mjs';

test('StateStore persists bindings atomically', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-discord-state-'));
  try {
    const first = new StateStore(directory, '123456789012345');
    first.setInfrastructure({
      controlChannelId: 'control',
      controlPanelMessageId: 'control-panel',
      transferCategoryId: 'others',
      transferTextChannelId: 'transfer-text',
    });
    first.setBinding('thread-1', {
      channelId: 'channel-1',
      watchLevel: 'normal',
      controlPanelMessageId: 'task-panel',
    });

    const second = new StateStore(directory, '123456789012345');
    assert.equal(second.binding('thread-1').channelId, 'channel-1');
    assert.equal(second.binding('thread-1').threadId, 'thread-1');
    assert.equal(second.bindingByChannel('channel-1').threadId, 'thread-1');
    assert.equal(second.snapshot().infrastructure.controlChannelId, 'control');
    assert.equal(second.snapshot().infrastructure.controlPanelMessageId, 'control-panel');
    assert.equal(second.snapshot().infrastructure.transferCategoryId, 'others');
    assert.equal(second.snapshot().infrastructure.transferTextChannelId, 'transfer-text');
    assert.equal(second.binding('thread-1').controlPanelMessageId, 'task-panel');
    assert.equal(second.binding('thread-1').completionReportsEnabled, true);
    second.setChatgptConversation('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', {
      channelId: 'chat-channel-1',
      name: 'Explicit chat',
      conversationUrl: 'https://chatgpt.com/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      responsePerformance: 'high',
    });
    second.setChatgptMessageRecord('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', 'discord-message-1', {
      state: 'dispatching',
    });
    const chatReload = new StateStore(directory, '123456789012345');
    assert.equal(chatReload.chatgptConversationByChannel('chat-channel-1').name, 'Explicit chat');
    assert.equal(
      chatReload.chatgptMessageRecord('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', 'discord-message-1').state,
      'dispatching',
    );
    second.setClientToolRequest('server|request:1', {
      status: 'completed',
      response: { success: true },
    });
    assert.equal(
      new StateStore(directory, '123456789012345').clientToolRequest('server|request:1').status,
      'completed',
    );
    second.setTurnRecord('thread-1', 'turn-1', {
      liveMessageId: 'message-live',
      userMessageIds: ['message-user'],
    });
    assert.deepEqual(second.turnRecord('thread-1', 'turn-1').userMessageIds, ['message-user']);
    second.setTurnRecord('thread-1', 'turn-1', {
      liveMessageId: null,
      finalMessageIds: ['message-final'],
    });
    assert.equal(second.turnRecord('thread-1', 'turn-1').liveMessageId, null);
    assert.deepEqual(second.turnRecord('thread-1', 'turn-1').finalMessageIds, ['message-final']);
    second.setSubagentThread('child-thread-1', {
      channelId: 'discord-thread-1',
      parentThreadId: 'thread-1',
      topLevelParentThreadId: 'thread-1',
      discordArchived: false,
    });
    second.setTurnRecord('child-thread-1', 'child-turn-1', {
      cardMessageId: 'child-card-1',
      status: 'inProgress',
    });
    second.setTurnRecord('child-thread-1', 'inherited-parent-turn', {
      cardMessageId: 'wrong-card',
    });
    second.retainSubagentTurnRecords('child-thread-1', new Set(['child-turn-1']));
    assert.equal(second.binding('child-thread-1').isSubagent, true);
    assert.equal(second.subagentThreadByDiscordId('discord-thread-1').threadId, 'child-thread-1');
    assert.equal(second.turnRecord('child-thread-1', 'child-turn-1').cardMessageId, 'child-card-1');
    assert.equal(second.turnRecord('child-thread-1', 'inherited-parent-turn'), null);
    assert.equal(second.bindings().some((binding) => binding.threadId === 'child-thread-1'), false);
    const subagentReload = new StateStore(directory, '123456789012345');
    assert.equal(subagentReload.subagentThread('child-thread-1').parentThreadId, 'thread-1');
    assert.equal(subagentReload.subagentThreads().length, 1);
    assert.throws(() => second.setBinding(undefined, { channelId: 'broken' }), /valid threadId/);
    second.setProjectCategory('c:\\git\\example', {
      path: 'C:\\git\\Example',
      name: 'Codex - Example',
      categoryIds: ['category-1'],
    });
    assert.deepEqual(second.projectCategories().map((project) => project.path), ['C:\\git\\Example']);

    const projectReload = new StateStore(directory, '123456789012345');
    assert.deepEqual(projectReload.projectCategory('c:\\git\\example').categoryIds, ['category-1']);
    projectReload.removeProjectCategory('c:\\git\\example');
    assert.equal(projectReload.projectCategory('c:\\git\\example'), null);

    projectReload.update((state) => { state.bindings.undefined = { channelId: 'legacy-corruption' }; });
    const migrated = new StateStore(directory, '123456789012345');
    assert.equal(migrated.snapshot().bindings.undefined, undefined);
  } finally {
    const resolved = path.resolve(directory);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir())));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});

test('StateStore migrates the legacy Codex Remote category without losing bindings', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-discord-state-v1-'));
  try {
    fs.writeFileSync(path.join(directory, 'state.json'), JSON.stringify({
      schemaVersion: 1,
      guildId: '123456789012345',
      infrastructure: { categoryId: 'legacy-category', controlChannelId: 'control' },
      bindings: { 'thread-1': { channelId: 'channel-1' } },
      autoCatchupProjects: { legacy: { path: 'C:\\work' } },
    }));
    const state = new StateStore(directory, '123456789012345').snapshot();
    assert.equal(state.schemaVersion, 8);
    assert.equal(state.infrastructure.controlCategoryId, 'legacy-category');
    assert.equal(state.infrastructure.transferCategoryId, null);
    assert.equal(state.infrastructure.transferTextChannelId, null);
    assert.equal(state.infrastructure.chatgptCategoryId, null);
    assert.deepEqual(state.chatgptConversations, {});
    assert.equal(state.bindings['thread-1'].channelId, 'channel-1');
    assert.equal(state.bindings['thread-1'].completionReportsEnabled, true);
    assert.equal(state.autoCatchupProjects, undefined);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('StateStore migrates v2 project and completed-turn identities into the current card ledger', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-discord-state-v2-'));
  try {
    fs.writeFileSync(path.join(directory, 'state.json'), JSON.stringify({
      schemaVersion: 2,
      guildId: '123456789012345',
      infrastructure: {},
      projectCategories: {
        'c:\\git\\example': { path: 'C:\\git\\Example', categoryIds: ['category-1'] },
      },
      bindings: {
        'thread-1': {
          channelId: 'channel-1',
          lastCompletedTurnId: 'turn-1',
          lastCompletionMessageId: 'message-final',
        },
      },
    }));
    const state = new StateStore(directory, '123456789012345').snapshot();
    assert.equal(state.schemaVersion, 8);
    assert.equal(state.projectCategories['c:\\git\\example'].projectId, 'prj_35574e3c6147');
    assert.deepEqual(state.bindings['thread-1'].turnMessages['turn-1'].finalMessageIds, ['message-final']);
    assert.equal(state.bindings['thread-1'].turnMessages['turn-1'].cardMessageId, 'message-final');
    assert.equal(state.bindings['thread-1'].turnMessages['turn-1'].status, 'completed');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('StateStore migrates v5 state with an isolated subagent ledger', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-discord-state-v5-'));
  try {
    fs.writeFileSync(path.join(directory, 'state.json'), JSON.stringify({
      schemaVersion: 5,
      guildId: '123456789012345',
      infrastructure: {},
      projectCategories: {},
      bindings: { 'thread-1': { channelId: 'channel-1' } },
      clientToolRequests: {},
    }));
    const store = new StateStore(directory, '123456789012345');
    assert.equal(store.snapshot().schemaVersion, 8);
    assert.deepEqual(store.snapshot().subagentThreads, {});
    assert.equal(store.binding('thread-1').channelId, 'channel-1');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('StateStore migrates v6 state and preserves explicit ChatGPT links only', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-discord-state-v6-'));
  try {
    fs.writeFileSync(path.join(directory, 'state.json'), JSON.stringify({
      schemaVersion: 6,
      guildId: '123456789012345',
      infrastructure: { controlCategoryId: 'control-category' },
      projectCategories: {},
      bindings: {},
      subagentThreads: {},
      clientToolRequests: {},
    }));
    const store = new StateStore(directory, '123456789012345');
    assert.equal(store.snapshot().schemaVersion, 8);
    assert.deepEqual(store.chatgptConversations(), []);
    assert.equal(store.snapshot().infrastructure.chatgptControlChannelId, null);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('StateStore persists hidden projects while excluding their Discord mirror bindings by default', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-discord-state-hidden-project-'));
  try {
    const store = new StateStore(directory, '123456789012345');
    store.setHiddenProject('c:\\git\\hidden', {
      projectId: 'prj_hidden',
      path: 'C:\\git\\hidden',
      name: 'Codex - hidden',
      hiddenBy: 'user-1',
    });
    store.setBinding('thread-hidden', {
      projectKey: 'c:\\git\\hidden',
      channelId: 'channel-hidden',
      turnMessages: { 'turn-1': { finalMessageIds: ['message-1'] } },
    });
    store.hideBinding('thread-hidden', { cwd: 'C:\\git\\hidden' });

    assert.equal(store.isProjectHidden('c:\\git\\hidden'), true);
    assert.equal(store.hiddenProject('c:\\git\\hidden').projectId, 'prj_hidden');
    assert.equal(store.bindings().length, 0);
    assert.equal(store.bindings({ includeHidden: true })[0].hidden, true);
    assert.equal(store.binding('thread-hidden').channelId, null);
    assert.equal(store.bindingByChannel(null), null);
    assert.equal(store.bindingByChannel(''), null);
    assert.deepEqual(store.binding('thread-hidden').turnMessages, {});

    const reloaded = new StateStore(directory, '123456789012345');
    assert.equal(reloaded.hiddenProjects().length, 1);
    assert.equal(reloaded.bindings().length, 0);
    reloaded.removeHiddenProject('c:\\git\\hidden');
    reloaded.setBinding('thread-hidden', { hidden: false, channelId: 'channel-restored' });
    assert.equal(reloaded.bindings()[0].channelId, 'channel-restored');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
