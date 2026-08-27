import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  listAllThreads,
  pauseActiveGoals,
  resumePausedGoals,
  waitForTurnCompletion,
} from './runtime-update-drain.mjs';

const launcherRoot = path.dirname(fileURLToPath(import.meta.url));

class FakeClient {
  constructor(handler) {
    this.handler = handler;
    this.calls = [];
  }

  async call(method, params) {
    this.calls.push({ method, params });
    return this.handler(method, params);
  }
}

test('listAllThreads follows cursors without losing thread status', async () => {
  const client = new FakeClient((method, params) => {
    assert.equal(method, 'thread/list');
    if (!params.cursor) {
      return { data: [{ id: 'T2', status: { type: 'active' } }], nextCursor: 'NEXT' };
    }
    assert.equal(params.cursor, 'NEXT');
    return { data: [{ id: 'T1', status: 'idle' }], nextCursor: null };
  });

  assert.deepEqual(await listAllThreads(client), [
    { id: 'T2', status: { type: 'active' } },
    { id: 'T1', status: 'idle' },
  ]);
});

test('pauseActiveGoals persists every newly paused goal and preserves pre-paused goals', async () => {
  const goals = new Map([
    ['ACTIVE-GOAL', 'active'],
    ['PAUSED-GOAL', 'paused'],
    ['NO-GOAL', null],
  ]);
  const client = new FakeClient((method, params) => {
    if (method === 'thread/list') {
      return {
        data: [
          { id: 'ACTIVE-GOAL', status: 'active' },
          { id: 'PAUSED-GOAL', status: 'idle' },
          { id: 'NO-GOAL', status: 'idle' },
        ],
        nextCursor: null,
      };
    }
    if (method === 'thread/goal/get') {
      const status = goals.get(params.threadId);
      return { goal: status ? { threadId: params.threadId, status } : null };
    }
    if (method === 'thread/goal/set') {
      assert.equal(params.status, 'paused');
      goals.set(params.threadId, 'paused');
      return { goal: { threadId: params.threadId, status: 'paused' } };
    }
    throw new Error(`Unexpected method: ${method}`);
  });
  const persisted = [];
  const result = await pauseActiveGoals(
    client,
    { schemaVersion: 1, pausedThreadIds: ['ALREADY-RECORDED'] },
    (state) => persisted.push(structuredClone(state)),
  );

  assert.deepEqual(result.pausedThreadIds, ['ACTIVE-GOAL', 'ALREADY-RECORDED']);
  assert.deepEqual(result.activeThreadIds, ['ACTIVE-GOAL']);
  assert.equal(goals.get('PAUSED-GOAL'), 'paused');
  assert.ok(persisted.some((state) => state.pausedThreadIds.includes('ACTIVE-GOAL')));
  assert.equal(
    client.calls.filter((call) => call.method === 'thread/goal/set').length,
    1,
  );
});

test('resumePausedGoals resumes only goals recorded by this update', async () => {
  const goals = new Map([
    ['PAUSED-BY-UPDATE', 'paused'],
    ['CHANGED-AFTER-PAUSE', 'blocked'],
  ]);
  const client = new FakeClient((method, params) => {
    if (method === 'thread/goal/get') {
      return { goal: { threadId: params.threadId, status: goals.get(params.threadId) } };
    }
    if (method === 'thread/goal/set') {
      assert.equal(params.threadId, 'PAUSED-BY-UPDATE');
      assert.equal(params.status, 'active');
      goals.set(params.threadId, 'active');
      return { goal: { threadId: params.threadId, status: 'active' } };
    }
    throw new Error(`Unexpected method: ${method}`);
  });

  const result = await resumePausedGoals(client, {
    pausedThreadIds: ['PAUSED-BY-UPDATE', 'CHANGED-AFTER-PAUSE'],
  });
  assert.deepEqual(result.resumedThreadIds, ['PAUSED-BY-UPDATE']);
  assert.deepEqual(result.unchangedThreadIds, ['CHANGED-AFTER-PAUSE']);
  assert.equal(goals.get('CHANGED-AFTER-PAUSE'), 'blocked');
});

test('waitForTurnCompletion closes the notification race using threadId from params', async () => {
  const client = new FakeClient((method) => {
    assert.equal(method, 'thread/turns/list');
    return { data: [{ id: 'TURN', status: 'inProgress' }] };
  });
  client.waitFor = async (predicate) => {
    const notification = {
      method: 'turn/completed',
      params: { threadId: 'THREAD', turn: { id: 'TURN', status: 'completed' } },
    };
    assert.equal(predicate(notification), true);
    return notification;
  };

  const result = await waitForTurnCompletion(client, 'THREAD', 'TURN', 10_000);
  assert.equal(result.status, 'completed');
});

test('waitForTurnCompletion re-reads terminal state after a missed notification', async () => {
  let reads = 0;
  const client = new FakeClient((method) => {
    assert.equal(method, 'thread/turns/list');
    reads += 1;
    return {
      data: [{ id: 'TURN', status: reads === 1 ? 'inProgress' : 'completed' }],
    };
  });
  client.waitFor = async () => {
    throw new Error('Notification wait timed out.');
  };

  const result = await waitForTurnCompletion(client, 'THREAD', 'TURN', 10_000);
  assert.equal(result.status, 'completed');
  assert.equal(reads, 2);
});

test('shared launcher drains turns and replaces the server on package updates', () => {
  const source = fs.readFileSync(path.join(launcherRoot, 'Start-CodexShared.ps1'), 'utf8');
  assert.match(source, /Wait-RuntimeUpdateQuiescence/);
  assert.match(source, /Restore-RuntimeUpdateGoals/);
  assert.match(source, /restartAfterCleanup/);
  assert.doesNotMatch(source, /Updated Desktop attached automatically to the existing shared app-server/);
});

test('one-shot refresh waits the exact turn before replacing the owned runtime', () => {
  const source = fs.readFileSync(
    path.join(launcherRoot, 'Refresh-CodexSharedRuntime.ps1'),
    'utf8',
  );
  assert.match(source, /WaitForTurnId/);
  assert.match(source, /Invoke-DrainCommand -Command 'wait-turn'/);
  assert.match(source, /Wait-AllThreadsIdle/);
  assert.match(source, /Wait-ForOldRuntimeExit/);
  assert.match(source, /Wait-ForNewRuntime/);
  assert.match(source, /Send-CompletionCallback/);
  assert.match(source, /controlScript deliver \$WaitForThreadId/);
  assert.match(source, /Start-DetachedRefreshController/);
  assert.match(source, /Register-ScheduledTask/);
  assert.match(source, /Start-ScheduledTask/);
  assert.match(source, /controllerLaunchMode = 'scheduled-task'/);
  assert.match(source, /requestId = \$RefreshRequestId/);
  assert.match(source, /DesktopCloseTimeoutSeconds = 120/);
  assert.match(source, /AddSeconds\(\$DesktopCloseTimeoutSeconds\)/);
  assert.doesNotMatch(source, /AddSeconds\(15\)/);
});
