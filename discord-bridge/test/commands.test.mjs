import test from 'node:test';
import assert from 'node:assert/strict';
import { commandPayload } from '../src/commands.mjs';

test('guild command payload contains the full remote operation surface', () => {
  assert.equal(commandPayload.length, 2);
  const subcommands = commandPayload[0].options.map((option) => option.name);
  for (const expected of [
    'status', 'tasks', 'open', 'deliver', 'send', 'steer', 'compose', 'interrupt', 'watch', 'pending', 'sync', 'refresh',
    'model', 'reasoning', 'permissions', 'mode', 'memory', 'usage', 'resources', 'goal', 'compact', 'fork', 'review', 'terminals',
  ]) {
    assert.ok(subcommands.includes(expected), `missing /codex ${expected}`);
  }
  assert.equal(subcommands.length, 25, 'Discord permits at most 25 top-level subcommands');
  for (const removed of ['bind', 'unbind', 'catchup', 'autocatchup']) {
    assert.equal(subcommands.includes(removed), false, `/codex ${removed} should be removed`);
  }
  assert.equal(commandPayload[0].default_member_permissions, '8');
  assert.equal(commandPayload[1].name, 'codex-files');
  assert.equal(commandPayload[1].default_member_permissions, '8');
  assert.equal(commandPayload[1].options[0].name, 'task');
  assert.equal(commandPayload[1].options[0].autocomplete, true);
});

test('required slash command options always precede optional options', () => {
  const visit = (subcommand, parent = 'codex') => {
    let optionalSeen = false;
    for (const option of subcommand.options ?? []) {
      if (option.type === 1 || option.type === 2) {
        visit(option, `${parent}/${subcommand.name}`);
        continue;
      }
      if (!option.required) optionalSeen = true;
      if (option.required) {
        assert.equal(optionalSeen, false, `${parent}/${subcommand.name}/${option.name} is required after an optional option`);
      }
    }
  };
  for (const command of commandPayload) {
    visit(command, command.name);
  }
});
