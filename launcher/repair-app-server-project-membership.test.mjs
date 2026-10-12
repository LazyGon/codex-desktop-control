import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveRecoveryProjects, planRecoveryAssignment } from './repair-app-server-project-membership.mjs';

test('matches existing project by all normalized roots rather than display name', () => {
  const mapping = resolveRecoveryProjects({ 'local-projects': { legacy: { rootPaths: ['C:\\Repo', 'D:\\Docs'] } } }, [
    { id: 'wrong', roots: [{ path: 'C:\\other' }] },
    { id: 'native', roots: [{ path: 'd:\\docs\\' }, { path: '\\\\?\\c:\\repo' }] },
  ]);
  assert.equal(mapping.get('legacy'), 'native');
});
test('missing or ambiguous project fails closed', () => {
  const backup = { 'local-projects': { legacy: { rootPaths: ['C:\\repo'] } } };
  assert.throws(() => resolveRecoveryProjects(backup, []), /found 0/);
  assert.throws(() => resolveRecoveryProjects(backup, [1, 2].map(id => ({ id, roots: [{ path: 'C:\\repo' }] }))), /found 2/);
});
test('only missing assignments are migrated; newer membership is preserved', () => {
  const mapping = new Map([['legacy', 'native']]);
  const assignment = { projectKind: 'local', projectId: 'legacy' };
  assert.equal(planRecoveryAssignment({ id: 'task', projectId: null }, assignment, mapping).phase, 'prepared');
  assert.equal(planRecoveryAssignment({ id: 'task', projectId: 'native' }, assignment, mapping).phase, 'already-correct');
  assert.equal(planRecoveryAssignment({ id: 'task', projectId: 'newer' }, assignment, mapping).phase, 'preserved-newer-assignment');
  assert.equal(planRecoveryAssignment({ id: 'task' }, { ...assignment, projectKind: 'remote' }, mapping), null);
});
