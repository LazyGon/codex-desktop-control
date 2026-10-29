import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  appServerProjectForThread,
  appServerProjectKey,
  desktopProjectSnapshot,
  projectDescriptorForThread,
  projectDescriptorsFromSnapshot,
  projectForThread,
  readDesktopProjectSnapshot,
  withAppServerProjects,
} from '../src/desktop-project-state.mjs';

test('groups Desktop tasks without a project assignment or saved root as projectless', () => {
  const snapshot = desktopProjectSnapshot({
    'local-projects': {
      'local-work': { name: 'work-project', rootPaths: ['C:\\git\\work'] },
    },
    'thread-project-assignments': {
      assigned: { projectKind: 'local', projectId: 'local-work', cwd: 'C:\\git\\work' },
    },
  });

  const generated = {
    id: 'generated',
    cwd: 'C:\\Users\\example\\Documents\\Codex\\2026-07-25\\new-chat',
  };
  assert.deepEqual(projectDescriptorForThread(generated, snapshot), {
    id: 'prj_e1bdad172a61',
    key: '__no_project__',
    path: '(no project)',
    name: 'Codex - No Project',
  });

  assert.deepEqual(
    projectDescriptorForThread({ id: 'assigned', cwd: 'C:\\git\\work' }, snapshot),
    {
      id: 'local-work',
      key: 'local-work',
      path: 'C:\\git\\work',
      name: 'Codex - work-project',
    },
  );
});

test('resolves unassigned future tasks from the most specific containing project root', () => {
  const snapshot = desktopProjectSnapshot({
    'local-projects': {
      'local-parent': { name: 'parent', rootPaths: ['C:\\runtime\\runs'] },
      'local-specific': { name: 'specific', rootPaths: ['C:\\runtime\\runs\\dedicated'] },
    },
    'thread-project-assignments': {},
  });

  const thread = { id: 'future', cwd: 'c:\\RUNTIME\\runs\\dedicated\\RUN-2\\scratch\\workspace' };
  assert.deepEqual(projectDescriptorForThread(thread, snapshot), {
    id: 'local-specific',
    key: 'local-specific',
    path: 'C:\\runtime\\runs\\dedicated',
    name: 'Codex - specific',
  });
});

test('groups different assigned and root-contained scratch cwds by Desktop project identity and name', () => {
  const projectId = 'local-7dc2f676cee74a9b88423089d51a209c';
  const snapshot = desktopProjectSnapshot({
    'local-projects': {
      [projectId]: {
        name: 'economic-support-automation',
        rootPaths: [
          'C:\\git\\other\\economic-support-automation',
          'C:\\git\\other\\economic-support-supervisor-runtime\\runs',
        ],
      },
      'local-other': {
        name: 'other-project',
        rootPaths: ['C:\\git\\other\\other-runtime\\workspace'],
      },
    },
    'thread-project-assignments': {
      assigned: { projectKind: 'local', projectId, cwd: 'C:\\elsewhere\\workspace' },
    },
  });
  const assigned = projectDescriptorForThread({
    id: 'assigned',
    cwd: 'C:\\elsewhere\\workspace',
  }, snapshot);
  const future = projectDescriptorForThread({
    id: 'future',
    cwd: 'C:\\git\\other\\economic-support-supervisor-runtime\\runs\\RUN-NEW\\scratch\\workspace',
  }, snapshot);
  const other = projectDescriptorForThread({
    id: 'other',
    cwd: 'C:\\git\\other\\other-runtime\\workspace',
  }, snapshot);

  assert.deepEqual(assigned, future);
  assert.deepEqual(future, {
    id: projectId,
    key: projectId,
    path: 'C:\\git\\other\\economic-support-automation',
    name: 'Codex - economic-support-automation',
  });
  assert.equal(other.key, 'local-other');
  assert.notEqual(other.key, future.key);
});

test('falls back to App Server cwd when Desktop state cannot be read', (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-project-state-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const snapshot = readDesktopProjectSnapshot(path.join(directory, 'missing.json'));

  assert.equal(snapshot.available, false);
  assert.equal(projectDescriptorForThread({ id: 'thread', cwd: 'C:\\git\\work' }, snapshot).path,
    'C:\\git\\work');
});

test('App Server native project identity takes precedence over conflicting Desktop assignment', () => {
  const nativeProjectId = '01a037d8-e412-7af3-8b8f-36c3cf4e338c';
  const snapshot = withAppServerProjects(desktopProjectSnapshot({
    'local-projects': {
      'local-economic-support': {
        name: 'economic-support',
        rootPaths: ['C:\\git\\other\\economic-support'],
      },
    },
    'thread-project-assignments': {
      target: { projectKind: 'local', projectId: 'local-economic-support' },
    },
  }), [{
    id: nativeProjectId,
    name: 'economic-support-automation',
    roots: [{ path: 'C:\\Users\\example\\AppData\\Local\\EconomicSupport\\instances\\default' }],
  }]);
  const thread = {
    id: 'target',
    projectId: nativeProjectId,
    cwd: 'C:\\git\\other\\economic-support',
  };

  assert.equal(appServerProjectForThread(thread, snapshot).projectId, nativeProjectId);
  assert.equal(projectForThread(thread, snapshot).resolution, 'app-server-project-id');
  assert.deepEqual(projectDescriptorForThread(thread, snapshot), {
    id: nativeProjectId,
    key: appServerProjectKey(nativeProjectId),
    path: 'C:\\Users\\example\\AppData\\Local\\EconomicSupport\\instances\\default',
    name: 'Codex - economic-support-automation',
  });
});

test('App Server native project identity takes precedence over Desktop root containment when unassigned', () => {
  const snapshot = withAppServerProjects(desktopProjectSnapshot({
    'local-projects': {
      'local-root': { name: 'root-fallback', rootPaths: ['C:\\runtime'] },
    },
    'thread-project-assignments': {},
  }), [{
    id: 'native',
    name: 'native-project',
    roots: [{ path: 'C:\\native' }],
  }]);
  const thread = { id: 'unassigned', projectId: 'native', cwd: 'C:\\runtime\\scratch' };

  assert.equal(projectForThread(thread, snapshot).resolution, 'app-server-project-id');
  assert.deepEqual(projectDescriptorForThread(thread, snapshot), {
    id: 'native',
    key: appServerProjectKey('native'),
    path: 'C:\\native',
    name: 'Codex - native-project',
  });
});

test('same-name Desktop and App Server projects keep separate durable category identities', () => {
  const snapshot = withAppServerProjects(desktopProjectSnapshot({
    'local-projects': {
      shared: { name: 'same-name', rootPaths: ['C:\\local'] },
    },
  }), [{ id: 'native', name: 'same-name', roots: [{ path: 'C:\\native' }] }]);

  assert.deepEqual(projectDescriptorsFromSnapshot(snapshot).map(({ key, name }) => ({ key, name })), [
    { key: 'shared', name: 'Codex - same-name' },
    { key: 'app-server:native', name: 'Codex - same-name' },
  ]);
  assert.deepEqual(projectDescriptorsFromSnapshot(snapshot, 'Codex - ', ' [Alias]')
    .map(({ key, name }) => ({ key, name })), [
    { key: 'shared', name: 'Codex - same-name [Alias]' },
    { key: 'app-server:native', name: 'Codex - same-name [Alias]' },
  ]);
  assert.equal(projectDescriptorForThread(
    { id: 'native-task', cwd: 'C:\\native', projectId: 'native' },
    snapshot,
    'Codex - ',
    ' [Alias]',
  ).name, 'Codex - same-name [Alias]');
  assert.equal(projectDescriptorForThread(
    { id: 'native-task', cwd: 'C:\\native', projectId: 'native' },
    snapshot,
    'Codex [Alias] Task - ',
    '',
    true,
  ).name, 'Codex [Alias] Task - same-name');
});

test('recorded local project migration keeps parent and native tasks in the existing category', () => {
  const snapshot = withAppServerProjects(desktopProjectSnapshot({
    'local-projects': {
      'local-work': { name: 'before-rename', rootPaths: ['C:\\old-work'] },
    },
    'thread-project-assignments': {
      parent: { projectKind: 'local', projectId: 'local-work' },
    },
    'app-server-project-id-by-legacy-project-id-by-host': {
      'local:C:\\Users\\example\\.codex': { 'local-work': 'native-work' },
    },
  }, 'C:\\Users\\example\\.codex\\.codex-global-state.json'), [{
    id: 'native-work', name: 'current-work', roots: [{ path: 'C:\\current-work' }],
  }]);
  const parent = projectDescriptorForThread({ id: 'parent', cwd: 'C:\\old-work' }, snapshot);
  const child = projectDescriptorForThread({
    id: 'child', projectId: 'native-work', cwd: 'C:\\scratch\\documentation',
  }, snapshot);
  assert.deepEqual(parent, {
    id: 'local-work', key: 'local-work', path: 'C:\\current-work', name: 'Codex - current-work',
  });
  assert.deepEqual(child, parent);
  assert.deepEqual(projectDescriptorsFromSnapshot(snapshot), [parent]);
});

test('foreign-host or dangling migration records do not merge native categories', () => {
  for (const migration of [
    { 'local:C:\\Users\\other\\.codex': { 'local-work': 'native-work' } },
    { 'local:C:\\Users\\example\\.codex': { missing: 'native-work' } },
  ]) {
    const snapshot = withAppServerProjects(desktopProjectSnapshot({
      'local-projects': { 'local-work': { name: 'work', rootPaths: ['C:\\work'] } },
      'app-server-project-id-by-legacy-project-id-by-host': migration,
    }, 'C:\\Users\\example\\.codex\\.codex-global-state.json'), [{
      id: 'native-work', name: 'work', roots: [{ path: 'C:\\work' }],
    }]);
    const descriptor = projectDescriptorForThread({ id: 'child', projectId: 'native-work' }, snapshot);
    assert.equal(descriptor.key, 'app-server:native-work');
    assert.equal(projectDescriptorsFromSnapshot(snapshot).length, 2);
  }
});

test('ambiguous migration ownership keeps distinct native category identity', () => {
  const snapshot = withAppServerProjects(desktopProjectSnapshot({
    'local-projects': {
      'local-a': { name: 'work', rootPaths: ['C:\\a'] },
      'local-b': { name: 'work', rootPaths: ['C:\\b'] },
    },
    'app-server-project-id-by-legacy-project-id-by-host': {
      'local:C:\\Users\\example\\.codex': { 'local-a': 'native', 'local-b': 'native' },
    },
  }, 'C:\\Users\\example\\.codex\\.codex-global-state.json'), [{
    id: 'native', name: 'work', roots: [{ path: 'C:\\native' }],
  }]);
  assert.equal(projectDescriptorForThread({ id: 'child', projectId: 'native' }, snapshot).key,
    'app-server:native');
});

test('conflicting local-home aliases cannot choose the last native migration target', () => {
  const snapshot = withAppServerProjects(desktopProjectSnapshot({
    'local-projects': { 'local-work': { name: 'work', rootPaths: ['C:\\work'] } },
    'app-server-project-id-by-legacy-project-id-by-host': {
      'local:C:\\Users\\example\\.codex': { 'local-work': 'native-a' },
      'local:c:\\users\\EXAMPLE\\.codex': { 'local-work': 'native-b' },
    },
  }, 'C:\\Users\\example\\.codex\\.codex-global-state.json'), [
    { id: 'native-a', name: 'a', roots: [{ path: 'C:\\a' }] },
    { id: 'native-b', name: 'b', roots: [{ path: 'C:\\b' }] },
  ]);
  for (const id of ['native-a', 'native-b']) {
    assert.equal(projectDescriptorForThread({ id, projectId: id }, snapshot).key,
      `app-server:${id}`);
  }
});
