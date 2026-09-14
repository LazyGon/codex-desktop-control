import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createExclusiveBackup,
  loadBridgeProjects,
  reconcileDesktopProjectState,
} from './sync-desktop-projects.mjs';

test('creates distinct exclusive backups for concurrent launches in the same millisecond', context => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'project-backup-'));
  context.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const source = path.join(temporary, '.codex-global-state.json');
  const backups = path.join(temporary, 'backups');
  fs.writeFileSync(source, '{"version":1}', 'utf8');
  const identity = { date: new Date('2026-09-07T11:45:36.123Z'), processId: 42 };

  const first = createExclusiveBackup(source, backups, identity);
  const second = createExclusiveBackup(source, backups, identity);

  assert.notEqual(first, second);
  assert.match(path.basename(first), /20260907T114536123Z\.42\.bak$/);
  assert.match(path.basename(second), /20260907T114536123Z\.42\.1\.bak$/);
  assert.equal(fs.readFileSync(first, 'utf8'), '{"version":1}');
  assert.equal(fs.readFileSync(second, 'utf8'), '{"version":1}');
});

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

test('native App Server Project identity removes a stale local assignment', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'project-alias-'));
  const bridgeState = path.join(temporary, 'state.json');
  fs.writeFileSync(bridgeState, JSON.stringify({
    projectCategories: {},
    bindings: { 'luna-summary': { cwd: 'C:\\legacy-bridge-binding' } },
    hiddenProjects: {
      'local-automation': {
        projectId: 'local-automation',
        name: 'Codex - economic-support-automation',
      },
      'app-server:native-automation': {
        projectId: 'native-automation',
        name: 'Codex - economic-support-automation',
        namespace: 'app-server',
      },
    },
  }));
  const bridge = loadBridgeProjects(bridgeState);
  const original = {
    'electron-saved-workspace-roots': ['C:\\legacy-root'],
    'project-order': ['local-automation'],
    'pinned-project-ids': ['local-automation'],
    'local-projects': {
      'local-automation': {
        id: 'local-automation',
        name: 'economic-support-automation',
        rootPaths: ['C:\\legacy-root', 'C:\\legacy-runtime'],
        createdAt: 1,
        updatedAt: 1,
      },
    },
    'thread-project-assignments': {},
  };

  original['thread-project-assignments']['luna-summary'] = {
    projectKind: 'local',
    projectId: 'local-automation',
    cwd: 'C:\\legacy-root',
    pendingCoreUpdate: false,
  };
  const result = reconcileDesktopProjectState(original, {
    projectRoots: bridge.projectRoots,
    threads: [
      ...bridge.boundThreads,
      {
        id: 'luna-summary',
        cwd: 'C:\\portable-instance\\runtime\\summary',
        projectId: 'native-automation',
      },
    ],
  });

  assert.equal(result.state['thread-project-assignments']['luna-summary'], undefined);
  assert.equal(result.stats.assignmentsRemoved, 1);
  fs.rmSync(temporary, { recursive: true, force: true });
});
