import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { checkRequest, guardResultJson } from './guard.mjs';

const workspace = path.resolve('admin-terminal');
const config = { controlRoot: path.resolve('.') };
const request = {
  operationId: '9d14f17f-40cf-4cb8-867f-59cb53d23243',
  threadId: '11111111-1111-4111-8111-111111111111',
  workspace, scriptPath: path.join(workspace, 'Test-AdminExecution.ps1'),
  scriptSha256: 'A'.repeat(64), arguments: ['-JobPath', 'local-test.json'], purpose: 'read-only token check',
};
const session = { cwd: workspace, model: 'unchanged', approvalPolicy: 'never', sandbox: { type: 'dangerFullAccess' }, thread: { id: request.threadId, status: { type: 'active' } } };
test('exact permitted active task accepted without changing settings', () => {
  assert.deepEqual(checkRequest(request, config, session), { threadId: request.threadId, workspace, model: 'unchanged', sandbox: 'dangerFullAccess', approvalPolicy: 'never' });
});
test('restricted sandbox is not bypassed', () => {
  assert.throws(() => checkRequest(request, config, { ...session, sandbox: { type: 'workspaceWrite' } }), /sandbox/);
});
test('separate task approval cannot be bypassed', () => {
  assert.throws(() => checkRequest(request, config, { ...session, approvalPolicy: 'on-request' }), /approval policy/);
});
test('stopped or different task rejected', () => {
  assert.throws(() => checkRequest(request, config, { ...session, thread: { ...session.thread, status: { type: 'idle' } } }), /not active/);
  assert.throws(() => checkRequest(request, config, { ...session, thread: { ...session.thread, id: request.operationId } }), /not active/);
});
test('workspace and sibling-prefix escape rejected', () => {
  assert.throws(() => checkRequest({ ...request, workspace: path.resolve('other') }, config, session), /Workspace/);
  assert.throws(() => checkRequest({ ...request, scriptPath: path.resolve('../codex desktop control-evil/file.ps1') }, config, session), /outside/);
});
test('raw commands, invalid identifiers and credential-style separators not accepted', () => {
  assert.throws(() => checkRequest({ ...request, scriptPath: path.join(workspace, 'shell.cmd') }, config, session), /PowerShell/);
  assert.throws(() => checkRequest({ ...request, operationId: '-'.repeat(36) }, config, session), /UUID/);
  assert.throws(() => checkRequest({ ...request, arguments: ['command\nnext'] }, config, session), /control separators/);
  assert.throws(() => checkRequest({ ...request, scriptSha256: 'bad' }, config, session), /hash/);
});

test('guard result survives the installed legacy host code-page decoder', () => {
  const unicodeWorkspace = path.resolve('その他', '日本語😀');
  const unicodeRequest = { ...request, workspace: unicodeWorkspace, scriptPath: path.join(unicodeWorkspace, '診断.ps1') };
  const unicodeSession = { ...session, cwd: unicodeWorkspace };
  const admitted = checkRequest(unicodeRequest, config, unicodeSession);
  const legacyDecoder = new TextDecoder('shift_jis');
  const legacyBytes = Buffer.from(JSON.stringify(admitted), 'utf8');
  assert.notEqual(legacyDecoder.decode(legacyBytes), JSON.stringify(admitted));
  const envelope = guardResultJson(admitted);
  assert.match(envelope, /^[\x00-\x7f]*$/);
  assert.deepEqual(JSON.parse(legacyDecoder.decode(Buffer.from(envelope, 'utf8'))), admitted);
});
