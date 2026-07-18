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
    first.setInfrastructure({ controlChannelId: 'control' });
    first.setBinding('thread-1', { channelId: 'channel-1', watchLevel: 'normal' });

    const second = new StateStore(directory, '123456789012345');
    assert.equal(second.binding('thread-1').channelId, 'channel-1');
    assert.equal(second.binding('thread-1').threadId, 'thread-1');
    assert.equal(second.bindingByChannel('channel-1').threadId, 'thread-1');
    assert.equal(second.snapshot().infrastructure.controlChannelId, 'control');
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
    assert.throws(() => second.setBinding(undefined, { channelId: 'broken' }), /valid threadId/);
    second.setProjectCategory('c:\\git\\example', {
      path: 'C:\\git\\Example',
      name: 'Codex - Example',
      categoryIds: ['category-1'],
    });
    assert.deepEqual(second.projectCategories().map((project) => project.path), ['C:\\git\\Example']);

    const projectReload = new StateStore(directory, '123456789012345');
    assert.deepEqual(projectReload.projectCategory('c:\\git\\example').categoryIds, ['category-1']);

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
    assert.equal(state.schemaVersion, 4);
    assert.equal(state.infrastructure.controlCategoryId, 'legacy-category');
    assert.equal(state.bindings['thread-1'].channelId, 'channel-1');
    assert.equal(state.autoCatchupProjects, undefined);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('StateStore migrates v2 project and completed-turn identities into the v4 card ledger', () => {
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
    assert.equal(state.schemaVersion, 4);
    assert.equal(state.projectCategories['c:\\git\\example'].projectId, 'prj_35574e3c6147');
    assert.deepEqual(state.bindings['thread-1'].turnMessages['turn-1'].finalMessageIds, ['message-final']);
    assert.equal(state.bindings['thread-1'].turnMessages['turn-1'].cardMessageId, 'message-final');
    assert.equal(state.bindings['thread-1'].turnMessages['turn-1'].status, 'completed');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
