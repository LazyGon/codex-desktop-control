import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CONTROL_PANEL_MARKER,
  controlPanelPayload,
  taskPanelMarker,
  taskPanelPayload,
} from '../src/discord-panels.mjs';

function json(payload) {
  return {
    embeds: payload.embeds.map((embed) => embed.toJSON()),
    components: payload.components.map((component) => component.toJSON()),
  };
}

test('control panel exposes status, sync, pending, and task navigation UI', () => {
  const payload = json(controlPanelPayload({
    connected: true,
    pendingCount: 2,
    projectCount: 1,
    bindings: [
      { threadId: 'thread-active', name: 'Active task', cwd: 'C:\\work', taskStatus: 'active', archived: false },
      { threadId: 'thread-archived', name: 'Archived task', cwd: 'C:\\work', taskStatus: 'idle', archived: true },
    ],
  }));
  assert.equal(payload.embeds[0].footer.text, CONTROL_PANEL_MARKER);
  assert.deepEqual(payload.components[0].components.map((component) => component.custom_id), [
    'cx:ui:control:status',
    'cx:ui:control:sync',
    'cx:ui:control:pending',
  ]);
  assert.equal(payload.components[1].components[0].custom_id, 'cx:ui:control:open');
  assert.deepEqual(payload.components[1].components[0].options.map((option) => option.value), [
    'thread-active',
    'thread-archived',
  ]);
});

test('task panel exposes mode and watch selects plus safe task actions', () => {
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
  assert.equal(active.embeds[0].footer.text, taskPanelMarker(thread.id));
  assert.equal(active.components[0].components[0].custom_id, `cx:ui:task:compose:${thread.id}`);
  assert.deepEqual(active.components[0].components[0].options.map((option) => option.value), [
    'deliver', 'send', 'steer',
  ]);
  assert.equal(active.components[1].components[0].custom_id, `cx:ui:task:watch:${thread.id}`);
  assert.equal(active.components[1].components[0].options.find((option) => option.default).value, 'normal');
  assert.deepEqual(active.components[2].components.map((component) => component.custom_id), [
    `cx:ui:task:refresh:${thread.id}`,
    `cx:ui:task:pending:${thread.id}`,
    `cx:ui:task:archive:${thread.id}`,
    `cx:ui:task:interrupt:${thread.id}`,
  ]);
  assert.equal(active.components[2].components[2].label, 'Archive');
  assert.equal(active.components[2].components[3].disabled, false);

  const archived = json(taskPanelPayload({
    thread: { ...thread, status: { type: 'idle' } },
    binding: { threadId: thread.id, watchLevel: 'quiet', archived: true },
  }));
  assert.equal(archived.components[0].components[0].disabled, true);
  assert.equal(archived.components[1].components[0].options.find((option) => option.default).value, 'quiet');
  assert.equal(archived.components[2].components[2].label, 'Restore');
  assert.equal(archived.components[2].components[3].disabled, true);
});
