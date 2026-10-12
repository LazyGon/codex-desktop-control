import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readDesktopState, recoverDesktopProjects } from './desktop-state-recovery.mjs';

test('corrupt primary and adjacent backup recover from a validated launcher backup', context => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-recovery-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const primary = path.join(directory, 'state.json');
  const backups = path.join(directory, 'backups');
  fs.mkdirSync(backups);
  fs.writeFileSync(primary, '\0'.repeat(16));
  fs.writeFileSync(`${primary}.bak`, '[]');
  fs.writeFileSync(path.join(backups, 'unrelated.bak'), '{"wrong":true}');
  const valid = path.join(backups, 'state.json.valid.bak');
  fs.writeFileSync(valid, '{"keep":true}');
  const recovered = readDesktopState(primary, backups);
  assert.deepEqual(recovered.state, { keep: true });
  assert.equal(recovered.recoveredFrom, valid);
  assert.equal(fs.readFileSync(primary, 'utf8'), '\0'.repeat(16));
});

test('without a valid known backup corruption fails closed without leaking contents', context => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-recovery-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const primary = path.join(directory, 'state.json');
  fs.writeFileSync(primary, 'sensitive-unparseable-content');
  assert.throws(() => readDesktopState(primary, directory), /no valid known backup/);
  assert.equal(fs.readFileSync(primary, 'utf8'), 'sensitive-unparseable-content');
});

test('explicit project repair preserves newer identity, preferences and assignments', () => {
  const current = {
    identity: 'new', 'queued-follow-ups': { current: 'preserve' },
    'local-projects': { existing: { name: 'new name' } },
    'thread-project-assignments': { task: { projectId: 'existing' } },
    'electron-persisted-atom-state': { feature: false, 'unified-sidebar-pinned-order-v1': ['new-pin'] },
  };
  const backup = {
    identity: 'old', 'queued-follow-ups': { old: 'discard' },
    'local-projects': { existing: { name: 'old name' }, recovered: { name: 'recovered' } },
    'thread-project-assignments': { task: { projectId: 'old' }, oldTask: { projectId: 'recovered' } },
    'electron-persisted-atom-state': { feature: true, 'unified-sidebar-pinned-order-v1': ['old-pin'] },
  };
  const restored = recoverDesktopProjects(current, backup);
  assert.equal(restored.identity, 'new');
  assert.deepEqual(restored['queued-follow-ups'], current['queued-follow-ups']);
  assert.equal(restored['local-projects'].existing.name, 'new name');
  assert.equal(restored['local-projects'].recovered.name, 'recovered');
  assert.equal(restored['thread-project-assignments'].task.projectId, 'existing');
  assert.equal(restored['electron-persisted-atom-state'].feature, false);
  assert.deepEqual(restored['electron-persisted-atom-state']['unified-sidebar-pinned-order-v1'], ['new-pin', 'old-pin']);
  assert.deepEqual(recoverDesktopProjects(restored, backup), restored);
  assert.equal(current['local-projects'].recovered, undefined);
});

test('project repair rejects empty backups', () => {
  assert.throws(() => recoverDesktopProjects({}, { 'local-projects': {} }), /no local projects/);
});
