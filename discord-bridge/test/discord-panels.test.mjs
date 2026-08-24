import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CONTROL_PANEL_COLOR,
  CONTROL_PANEL_MARKER,
  controlPanelPayload,
  projectVisibilityPayload,
  recentHistoryPayload,
  taskPanelMarker,
  taskPanelPayload,
} from '../src/discord-panels.mjs';

function json(payload) {
  return {
    embeds: payload.embeds.map((embed) => embed.toJSON()),
    components: payload.components.map((component) => component.toJSON()),
  };
}

test('control panel exposes status, usage, resources, sync, recent history, pending, and task navigation UI', () => {
  const payload = json(controlPanelPayload({
    connected: true,
    pendingCount: 2,
    projectCount: 1,
    hiddenProjectCount: 1,
    bindings: [
      { threadId: 'thread-active', name: 'Active task', cwd: 'C:\\work', taskStatus: 'active', archived: false },
      { threadId: 'thread-archived', name: 'Archived task', cwd: 'C:\\work', taskStatus: 'idle', archived: true },
    ],
  }));
  assert.equal(payload.embeds[0].color, CONTROL_PANEL_COLOR);
  assert.equal(payload.embeds[0].footer.text, CONTROL_PANEL_MARKER);
  assert.deepEqual(payload.components[0].components.map((component) => component.custom_id), [
    'cx:ui:control:status',
    'cx:ui:control:usage',
    'cx:ui:control:sync',
    'cx:ui:control:pending',
    'cx:ui:control:recent-history',
  ]);
  assert.equal(payload.embeds[0].fields.find((field) => field.name === 'Projects').value, '表示 1 / 非表示 1');
  assert.equal(payload.components[1].components[0].custom_id, 'cx:ui:control:projects');
  assert.equal(payload.components[2].components[0].custom_id, 'cx:ui:control:resources');
  assert.deepEqual(payload.components[2].components[0].options.map((option) => option.value), [
    'mcp', 'skills', 'plugins', 'hooks', 'features',
  ]);
  assert.equal(payload.components[3].components[0].custom_id, 'cx:ui:control:open');
  assert.deepEqual(payload.components[3].components[0].options.map((option) => option.value), [
    'thread-active',
    'thread-archived',
  ]);
});

test('project visibility UI uses a paged select and explains destructive Discord-only removal', () => {
  const projects = Array.from({ length: 27 }, (_, index) => ({
    projectKey: `project-${index}`,
    projectId: `prj_${index}`,
    name: `Codex - Project ${index}`,
    path: `C:\\git\\project-${index}`,
    hidden: index === 26,
    taskCount: index + 1,
  }));
  const first = json(projectVisibilityPayload({ projects, key: 'screen-1', page: 0 }));
  assert.match(first.embeds[0].description, /Discord側のカテゴリとその配下チャンネル/);
  assert.match(first.embeds[0].description, /Codexのtask\/threadとローカルファイルは削除しません/);
  assert.equal(first.components[0].components[0].custom_id, 'cx:projects:screen-1:select');
  assert.equal(first.components[0].components[0].options.length, 25);
  assert.equal(first.components[1].components[0].disabled, true);
  assert.equal(first.components[1].components[1].disabled, false);

  const second = json(projectVisibilityPayload({ projects, key: 'screen-1', page: 1 }));
  assert.equal(second.components[0].components[0].options.length, 2);
  assert.match(second.components[0].components[0].options[1].label, /再表示/);
  assert.equal(second.components[1].components[0].disabled, false);
  assert.equal(second.components[1].components[1].disabled, true);
});

test('recent history UI offers only one, three, and seven day restore windows', () => {
  const payload = json(recentHistoryPayload());
  assert.equal(payload.embeds[0].title, '最近の履歴を復元');
  assert.match(payload.embeds[0].description, /非アーカイブ/);
  assert.match(payload.embeds[0].description, /推論要約/);
  assert.equal(payload.components[0].components[0].custom_id, 'cx:ui:control:recent-history-days');
  assert.deepEqual(payload.components[0].components[0].options.map((option) => option.value), ['1', '3', '7']);
});

test('task panel groups delivery, task, notification, and file actions into four menus', () => {
  const thread = {
    id: 'thread-1',
    name: 'Task one',
    cwd: 'C:\\work',
    status: { type: 'active' },
  };
  const active = json(taskPanelPayload({
    thread,
    binding: { threadId: thread.id, watchLevel: 'normal', archived: false },
  }));
  assert.equal(active.embeds[0].color, CONTROL_PANEL_COLOR);
  assert.equal(active.embeds[0].footer.text, taskPanelMarker(thread.id));
  assert.equal(active.components[0].components[0].custom_id, `cx:ui:task:compose:${thread.id}`);
  assert.deepEqual(active.components[0].components[0].options.map((option) => option.value), [
    'deliver', 'send', 'steer',
  ]);
  assert.equal(active.components[0].components[0].placeholder, '💬 指示を送る');
  assert.equal(active.embeds[0].fields.find((field) => field.name === 'Completion report').value, 'ON');
  assert.equal(active.embeds[0].fields.some((field) => field.name === 'Forked from'), false);
  assert.equal(active.components[1].components[0].custom_id, `cx:ui:task:actions:${thread.id}`);
  assert.equal(active.components[1].components[0].placeholder, '⚙️ タスクを管理');
  assert.deepEqual(active.components[1].components[0].options.map((option) => option.value), [
    'refresh', 'pending', 'controls', 'interrupt', 'archive',
  ]);
  assert.equal(active.components[2].components[0].custom_id, `cx:ui:task:notifications:${thread.id}`);
  assert.match(active.components[2].components[0].placeholder, /進行: 標準 \/ 完了: ON/);
  assert.deepEqual(active.components[2].components[0].options.map((option) => option.value), [
    'watch:quiet', 'watch:normal', 'watch:verbose', 'completion:enabled', 'completion:disabled',
  ]);
  assert.equal(active.components[3].components[0].custom_id, `cx:ui:task:file-actions:${thread.id}`);
  assert.equal(active.components[3].components[0].placeholder, '📁 ファイルを開く・取得');
  assert.deepEqual(active.components[3].components[0].options.map((option) => option.value), [
    'files', 'project', 'git',
  ]);

  const archived = json(taskPanelPayload({
    thread: { ...thread, status: { type: 'idle' } },
    binding: {
      threadId: thread.id,
      watchLevel: 'quiet',
      completionReportsEnabled: false,
      archived: true,
    },
  }));
  assert.equal(archived.embeds[0].color, CONTROL_PANEL_COLOR);
  assert.equal(archived.components[0].components[0].disabled, true);
  assert.deepEqual(archived.components[1].components[0].options.map((option) => option.value), [
    'refresh', 'pending', 'archive',
  ]);
  assert.equal(archived.components[1].components[0].options.at(-1).label, 'タスクを復元');
  assert.match(archived.components[2].components[0].placeholder, /進行: 少なめ \/ 完了: OFF/);
  assert.equal(archived.components[3].components[0].disabled ?? false, false);
  assert.equal(archived.embeds[0].fields.find((field) => field.name === 'Completion report').value, 'OFF');
});

test('forked task panel links its source channel without duplicating source history', () => {
  const payload = json(taskPanelPayload({
    thread: {
      id: 'forked-thread',
      name: 'Forked task',
      cwd: 'C:\\work',
      status: { type: 'idle' },
    },
    binding: {
      threadId: 'forked-thread',
      forkedFromThreadId: 'source-thread',
      forkedFromChannelId: '123456789012345678',
    },
  }));
  assert.equal(
    payload.embeds[0].fields.find((field) => field.name === 'Forked from').value,
    '<#123456789012345678> / task `source-thread`',
  );
});
