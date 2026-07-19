import test from 'node:test';
import assert from 'node:assert/strict';
import {
  goalPayload,
  reviewPayload,
  secondarySettingsPayload,
  taskControlPayload,
  terminalPayload,
} from '../src/codex-control-ui.mjs';

function json(payload) {
  return {
    embeds: payload.embeds.map((embed) => embed.toJSON()),
    components: payload.components.map((component) => component.toJSON()),
  };
}

const context = {
  thread: { id: 'thread-1', name: 'Task one', status: { type: 'idle' }, cwd: 'C:\\work' },
  binding: {
    threadId: 'thread-1',
    name: 'Task one',
    runtimeSettings: { collaborationMode: { mode: 'default' }, personality: 'pragmatic' },
    memoryMode: 'enabled',
  },
  runtime: {
    model: 'gpt-test',
    reasoningEffort: 'high',
    serviceTier: 'priority',
    activePermissionProfile: { id: ':workspace' },
  },
  models: [{
    id: 'gpt-test',
    model: 'gpt-test',
    displayName: 'GPT Test',
    description: 'Test model',
    hidden: false,
    defaultReasoningEffort: 'medium',
    supportedReasoningEfforts: [
      { reasoningEffort: 'medium', description: 'Balanced' },
      { reasoningEffort: 'high', description: 'Deep' },
    ],
    serviceTiers: [{ id: 'priority', name: 'Fast', description: 'Priority processing' }],
    supportsPersonality: true,
  }],
  profiles: [
    { id: ':read-only', description: 'Read only', allowed: true },
    { id: ':workspace', description: 'Workspace access', allowed: true },
  ],
  modes: [
    { name: 'Plan', mode: 'plan', model: null, reasoning_effort: null },
    { name: 'Default', mode: 'default', model: null, reasoning_effort: null },
  ],
  goal: { objective: 'Finish the task', status: 'active', tokenBudget: 1000, tokensUsed: 100, timeUsedSeconds: 10 },
  terminals: [{ processId: 'process-1', osPid: 123, command: 'npm test' }],
};

test('task control center uses five dropdown rows backed by app-server catalogs', () => {
  const payload = json(taskControlPayload(context));
  assert.equal(payload.components.length, 5);
  assert.deepEqual(payload.components.map((row) => row.components[0].custom_id), [
    'cx:ctl:model:thread-1',
    'cx:ctl:effort:thread-1',
    'cx:ctl:permission:thread-1',
    'cx:ctl:mode:thread-1',
    'cx:ctl:more:thread-1',
  ]);
  assert.equal(payload.components[0].components[0].options.find((option) => option.default).value, 'gpt-test');
  assert.equal(payload.components[1].components[0].options.find((option) => option.default).value, 'high');
  assert.equal(payload.components[2].components[0].options.find((option) => option.default).value, ':workspace');
  assert.equal(payload.components[3].components[0].options.find((option) => option.default).value, 'default');
  assert.deepEqual(payload.components[4].components[0].options.map((option) => option.value), [
    'status', 'tier', 'personality', 'memory', 'goal', 'compact', 'fork', 'review', 'terminals',
  ]);
});

test('secondary control screens expose dropdowns and safe return paths', () => {
  for (const kind of ['tier', 'personality', 'memory']) {
    const payload = json(secondarySettingsPayload({ ...context, kind }));
    assert.equal(payload.components.length, 2);
    assert.equal(payload.components[1].components[0].custom_id, 'cx:ctl:back:thread-1');
  }
  const review = json(reviewPayload('thread-1'));
  assert.equal(review.components[0].components[0].custom_id, 'cx:ctl:review:thread-1');
  assert.equal(review.components[0].components[0].options.length, 8);
});

test('goal and background terminal screens retain explicit destructive actions', () => {
  const goal = json(goalPayload('thread-1', context.goal));
  assert.deepEqual(goal.components[0].components.map((component) => component.custom_id), [
    'cx:ctl:goalset:thread-1',
    'cx:ctl:goalclear:thread-1',
    'cx:ctl:back:thread-1',
  ]);
  const terminals = json(terminalPayload('thread-1', context.terminals));
  assert.equal(terminals.components[0].components[0].custom_id, 'cx:ctl:terminal:thread-1');
  assert.equal(terminals.components[1].components[0].custom_id, 'cx:ctl:back:thread-1');
});
