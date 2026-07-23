import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileDesktopProjectState } from './sync-desktop-projects.mjs';

test('creates missing projects and assigns active and archived threads by cwd', () => {
  const ids = ['local-attendance', 'local-economic'];
  const original = {
    'electron-saved-workspace-roots': ['C:\\git\\other\\reasoning-vm'],
    'project-order': ['local-reasoning'],
    'pinned-project-ids': ['local-reasoning'],
    'local-projects': {
      'local-reasoning': {
        id: 'local-reasoning',
        name: 'reasoning-vm',
        rootPaths: ['C:\\git\\other\\reasoning-vm'],
        createdAt: 1,
        updatedAt: 1,
      },
    },
    'thread-project-assignments': {},
  };

  const result = reconcileDesktopProjectState(original, {
    projectRoots: [
      'C:\\git\\other\\reasoning-vm\\',
      'C:/git/other/attendance-automation',
      'C:\\git\\other\\economic-support',
    ],
    threads: [
      { id: 'attendance-thread', cwd: 'c:\\GIT\\other\\attendance-automation\\' },
      { id: 'economic-thread', cwd: 'C:\\git\\other\\economic-support' },
      { id: 'projectless-thread', cwd: null },
    ],
    now: 123,
    createProjectId: () => ids.shift(),
  });

  assert.deepEqual(original['electron-saved-workspace-roots'], ['C:\\git\\other\\reasoning-vm']);
  assert.equal(result.stats.projectsCreated, 2);
  assert.equal(result.stats.assignmentsCreated, 2);
  assert.equal(
    result.state['thread-project-assignments']['attendance-thread'].projectId,
    'local-attendance',
  );
  assert.equal(
    result.state['thread-project-assignments']['economic-thread'].projectId,
    'local-economic',
  );
  assert.equal(result.state['thread-project-assignments']['projectless-thread'], undefined);
  assert.deepEqual(
    result.state['local-projects']['local-attendance'].rootPaths,
    ['C:\\git\\other\\attendance-automation'],
  );
});

test('is idempotent and preserves non-local assignments', () => {
  const original = {
    'electron-saved-workspace-roots': ['C:\\repo'],
    'project-order': ['local-existing'],
    'pinned-project-ids': ['local-existing'],
    'local-projects': {
      'local-existing': {
        id: 'local-existing',
        name: 'repo',
        rootPaths: ['C:\\repo'],
        createdAt: 1,
        updatedAt: 1,
      },
    },
    'thread-project-assignments': {
      local: {
        projectKind: 'local',
        projectId: 'local-existing',
        cwd: 'C:\\repo',
        pendingCoreUpdate: false,
      },
      remote: {
        projectKind: 'remote',
        projectId: 'remote-project',
        cwd: 'C:\\repo',
      },
    },
  };

  const result = reconcileDesktopProjectState(original, {
    projectRoots: ['c:\\REPO'],
    threads: [
      { id: 'local', cwd: 'C:\\repo\\' },
      { id: 'remote', cwd: 'C:\\repo' },
    ],
    createProjectId: () => {
      throw new Error('must not create a project');
    },
  });

  assert.deepEqual(result.state, original);
  assert.equal(result.stats.projectsCreated, 0);
  assert.equal(result.stats.assignmentsUnchanged, 1);
  assert.equal(result.stats.assignmentsSkipped, 1);
});
