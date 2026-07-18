import test from 'node:test';
import assert from 'node:assert/strict';
import { commandPayload } from '../src/commands.mjs';

test('guild command payload contains the full remote operation surface', () => {
  assert.equal(commandPayload.length, 1);
  const subcommands = commandPayload[0].options.map((option) => option.name);
  for (const expected of ['status', 'tasks', 'open', 'deliver', 'send', 'steer', 'compose', 'interrupt', 'watch', 'pending', 'sync', 'refresh']) {
    assert.ok(subcommands.includes(expected), `missing /codex ${expected}`);
  }
  for (const removed of ['bind', 'unbind', 'catchup', 'autocatchup']) {
    assert.equal(subcommands.includes(removed), false, `/codex ${removed} should be removed`);
  }
  assert.equal(commandPayload[0].default_member_permissions, '8');
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
  for (const subcommand of commandPayload[0].options) {
    visit(subcommand);
  }
});
