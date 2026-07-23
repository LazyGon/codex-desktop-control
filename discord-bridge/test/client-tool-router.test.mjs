import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ClientToolRouter,
  ClientToolUnavailableError,
} from '../src/client-tool-router.mjs';

function fixture() {
  const calls = [];
  const codex = {
    listThreads: async (args) => {
      calls.push(['listThreads', args]);
      return args.archived
        ? { data: [{ id: 'archived-1', name: 'Archived', status: { type: 'notLoaded' } }] }
        : { data: [{ id: 'active-1', name: 'Active', cwd: 'C:\\work', status: { type: 'idle' } }] };
    },
    readThread: async (threadId) => {
      calls.push(['readThread', threadId]);
      return {
        thread: {
          id: threadId,
          name: 'Read task',
          turns: [
            { id: 'old', items: [] },
            {
              id: 'recent',
              items: [{
                type: 'commandExecution',
                id: 'command-1',
                aggregatedOutput: 'secret-ish output',
              }],
            },
          ],
        },
      };
    },
    updateThreadSettings: async (...args) => calls.push(['updateThreadSettings', ...args]),
    deliver: async (...args) => {
      calls.push(['deliver', ...args]);
      return { mode: 'steer', turnId: 'turn-1' };
    },
    archiveThread: async (...args) => calls.push(['archiveThread', ...args]),
    unarchiveThread: async (...args) => calls.push(['unarchiveThread', ...args]),
    setThreadName: async (...args) => calls.push(['setThreadName', ...args]),
    forkThread: async (...args) => {
      calls.push(['forkThread', ...args]);
      return { thread: { id: 'forked-1' } };
    },
    startThread: async (...args) => {
      calls.push(['startThread', ...args]);
      return { thread: { id: 'created-1' } };
    },
  };
  const automationStore = {
    execute: (args, context) => {
      calls.push(['automation', args, context]);
      return { automation: { id: args.id } };
    },
    listProjects: () => [{
      projectId: 'project-1',
      hostId: 'local',
      name: 'Project',
      rootPaths: ['C:\\work'],
    }],
    project: (projectId) => {
      assert.equal(projectId, 'project-1');
      return {
        projectId,
        hostId: 'local',
        name: 'Project',
        rootPaths: ['C:\\work'],
      };
    },
  };
  return {
    calls,
    router: new ClientToolRouter({ codex, automationStore }),
  };
}

test('client tool router covers app-server-backed Codex Desktop tools', async () => {
  const { router, calls } = fixture();

  const listed = await router.execute('codex_app', 'list_threads', { limit: 2 });
  assert.deepEqual(listed.threads.map((thread) => thread.threadId), ['active-1', 'archived-1']);
  assert.deepEqual(calls.slice(0, 2), [
    ['listThreads', { limit: 2, search: null, archived: false }],
    ['listThreads', { limit: 1, search: null, archived: true }],
  ]);

  const read = await router.execute('codex_app', 'read_thread', {
    threadId: 'active-1',
    turnLimit: 1,
  });
  assert.deepEqual(read.thread.turns.map((turn) => turn.id), ['recent']);
  assert.equal(read.thread.turns[0].items[0].aggregatedOutput, undefined);

  const sent = await router.execute('codex_app', 'send_message_to_thread', {
    threadId: 'active-1',
    prompt: 'Continue.',
    model: 'gpt-test',
    thinking: 'high',
  });
  assert.equal(sent.mode, 'steer');
  const delivery = calls.find((call) => call[0] === 'deliver');
  assert.deepEqual(delivery.slice(1, 4), ['active-1', 'Continue.', null]);
  assert.match(delivery[4], /^discord-tool-[a-f0-9]{12}$/);

  assert.deepEqual(
    await router.execute('codex_app', 'set_thread_archived', { archived: true }, { threadId: 'active-1' }),
    { hostId: 'local', threadId: 'active-1', archived: true },
  );
  assert.deepEqual(
    await router.execute('codex_app', 'set_thread_title', { title: 'Renamed' }, { threadId: 'active-1' }),
    { hostId: 'local', threadId: 'active-1', title: 'Renamed' },
  );
  assert.deepEqual(
    await router.execute('codex_app', 'fork_thread', {}, { threadId: 'active-1' }),
    { hostId: 'local', threadId: 'forked-1' },
  );
  assert.equal((await router.execute('codex_app', 'list_projects', {})).projects[0].projectId, 'project-1');

  const created = await router.execute('codex_app', 'create_thread', {
    prompt: 'New task.',
    target: {
      type: 'project',
      projectId: 'project-1',
      environment: { type: 'local' },
    },
  });
  assert.equal(created.threadId, 'created-1');
  assert.deepEqual(calls.find((call) => call[0] === 'startThread'), ['startThread', 'C:\\work']);

  const automation = await router.execute(
    'codex_app',
    'automation_update',
    { mode: 'view', id: 'youtube' },
    { threadId: 'active-1' },
  );
  assert.equal(automation.automation.id, 'youtube');
});

test('client tool router fails closed for Desktop-only and connector tools', async () => {
  const { router } = fixture();

  await assert.rejects(
    router.execute('codex_app', 'set_thread_pinned', { threadId: 'active-1', pinned: true }),
    ClientToolUnavailableError,
  );
  await assert.rejects(
    router.execute('codex_app', 'fork_thread', {
      threadId: 'active-1',
      environment: { type: 'worktree' },
    }),
    /Worktree forks require Codex Desktop orchestration/,
  );
  await assert.rejects(
    router.execute('codex_app', 'create_thread', {
      prompt: 'Projectless.',
      target: { type: 'projectless' },
    }),
    /Projectless task creation requires Codex Desktop/,
  );
  await assert.rejects(
    router.execute('google_drive', 'search', { query: 'anything' }),
    /requires its owning Desktop client or connector/,
  );
});
