import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ECONOMIC_SUPPORT_AUTOMATION_PROJECT_ROOT,
  ECONOMIC_SUPPORT_AUTOMATION_RUN_ROOT,
  desktopProjectSnapshot,
  projectCwdForThread,
  projectDescriptorForThread,
  readDesktopProjectSnapshot,
} from '../src/desktop-project-state.mjs';
import { projectIdFromKey } from '../src/util.mjs';

test('groups Desktop tasks without a project assignment or saved root as projectless', () => {
  const snapshot = desktopProjectSnapshot({
    'local-projects': {
      'local-work': { rootPaths: ['C:\\git\\work'] },
    },
    'thread-project-assignments': {
      assigned: { projectKind: 'local', projectId: 'local-work', cwd: 'C:\\git\\work' },
    },
  });

  const generated = {
    id: 'generated',
    cwd: 'C:\\Users\\example\\Documents\\Codex\\2026-07-25\\new-chat',
  };
  assert.equal(projectCwdForThread(generated, snapshot), null);
  assert.deepEqual(projectDescriptorForThread(generated, snapshot), {
    id: projectIdFromKey('__no_project__'),
    key: '__no_project__',
    path: '(no project)',
    name: 'Codex - No Project',
  });

  assert.equal(
    projectCwdForThread({ id: 'assigned', cwd: 'C:\\git\\work' }, snapshot),
    'C:\\git\\work',
  );
});

test('recognizes saved project roots for tasks started outside the Desktop UI', () => {
  const snapshot = desktopProjectSnapshot({
    'local-projects': {
      'local-work': { rootPaths: ['C:\\git\\work'] },
    },
    'thread-project-assignments': {},
  });

  assert.equal(
    projectCwdForThread({ id: 'discord-started', cwd: 'c:\\GIT\\work\\' }, snapshot),
    'c:\\GIT\\work\\',
  );
});

test('groups economic-support run scratches into one automation project', () => {
  const snapshot = desktopProjectSnapshot({
    'local-projects': {},
    'thread-project-assignments': {},
  });
  const first = {
    id: 'asu-first',
    cwd: `${ECONOMIC_SUPPORT_AUTOMATION_RUN_ROOT}\\RUN-1\\scratch\\workspace`,
  };
  const second = {
    id: 'asu-second',
    cwd: `${ECONOMIC_SUPPORT_AUTOMATION_RUN_ROOT}\\RUN-2\\scratch\\workspace`,
  };

  assert.equal(projectCwdForThread(first, snapshot), ECONOMIC_SUPPORT_AUTOMATION_PROJECT_ROOT);
  assert.deepEqual(
    projectDescriptorForThread(first, snapshot),
    projectDescriptorForThread(second, snapshot),
  );
  assert.equal(
    projectDescriptorForThread(first, snapshot).name,
    'Codex - economic-support-automation',
  );
  assert.equal(
    projectCwdForThread(
      { id: 'other', cwd: 'C:\\git\\other\\other-runtime\\runs\\RUN-1' },
      snapshot,
    ),
    null,
  );
});

test('falls back to App Server cwd when Desktop state cannot be read', (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-project-state-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const snapshot = readDesktopProjectSnapshot(path.join(directory, 'missing.json'));

  assert.equal(snapshot.available, false);
  assert.equal(
    projectCwdForThread({ id: 'thread', cwd: 'C:\\git\\work' }, snapshot),
    'C:\\git\\work',
  );
});
