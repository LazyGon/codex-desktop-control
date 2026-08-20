import test from 'node:test';
import assert from 'node:assert/strict';

import { findCodexSubcommand, routeCodexArguments } from './codex-routing.mjs';

test('plain Codex TUI invocations route to the shared app-server', () => {
  assert.deepEqual(routeCodexArguments([]), { mode: 'shared', subcommand: null });
  assert.deepEqual(routeCodexArguments(['continue this task']), {
    mode: 'shared',
    subcommand: null,
  });
  assert.deepEqual(routeCodexArguments(['-C', String.raw`C:\work`, '--no-alt-screen']), {
    mode: 'shared',
    subcommand: null,
  });
});

test('task-producing subcommands never silently create an isolated run', () => {
  for (const subcommand of ['exec', 'e', 'review', 'resume', 'fork']) {
    assert.deepEqual(routeCodexArguments([subcommand]), { mode: 'unsupported', subcommand });
  }
  assert.equal(findCodexSubcommand(['-C', String.raw`C:\exec`, 'review']), 'review');
});

test('administrative commands and metadata pass through to the original CLI', () => {
  for (const subcommand of ['login', 'update', 'doctor', 'mcp', 'app-server']) {
    assert.deepEqual(routeCodexArguments([subcommand]), { mode: 'passthrough', subcommand });
  }
  assert.deepEqual(routeCodexArguments(['--version']), {
    mode: 'passthrough',
    subcommand: null,
  });
  assert.deepEqual(routeCodexArguments(['--help']), {
    mode: 'passthrough',
    subcommand: null,
  });
});
