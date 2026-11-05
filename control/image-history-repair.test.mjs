import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { repairImageHistory, compactImages } from './image-history-repair.mjs';
import { imageFailure, imageSafety, confirmationPath, exclusiveJson, pinFile,
  repairIdentity, resumeSettings, sha256, permitDecision } from './image-repair-policy.mjs';
import { confirmImageCause } from './image-history-repair-cli.mjs';
import { prepareImageReferences } from './image-reference-content.mjs';
import { replaceArchivedImages } from './image-reference-windows.mjs';

const clone = value => structuredClone(value);
const hasMutation = calls => calls.some(c => ['thread/resume', 'thread/archive', 'thread/unarchive',
  'thread/compact/start', 'turn/start', 'thread/goal/set'].includes(c.method));
const id = '11111111-1111-4111-8111-111111111111';
const failedId = '22222222-2222-4222-8222-222222222222';
const failure = () => ({ id: failedId, status: 'failed', error: { codexErrorInfo: 'other', message: '{"detail":"Bad Request"}' } });
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'image-recovery-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const codexHome = path.join(directory, 'codex'), sessions = path.join(codexHome, 'sessions');
  const archives = path.join(codexHome, 'archived_sessions');
  fs.mkdirSync(sessions, { recursive: true }); fs.mkdirSync(archives);
  const sourcePath = path.join(sessions, 'rollout-test-' + id + '.jsonl');
  const original = Buffer.from(JSON.stringify({ type: 'response_item', payload: { type: 'message', content: [
    { type: 'input_text', text: '日本語の依頼を維持する。' },
    { image_url: 'data:image/png;base64,' + Buffer.alloc(1800, 17).toString('base64'), type: 'input_image' },
  ] } }) + '\n');
  fs.writeFileSync(sourcePath, original);
  const record = { thread: { id, cwd: directory, model: 'selected-model', modelProvider: 'openai',
    reasoningEffort: 'high', canAcceptDirectInput: true, source: 'vscode', path: sourcePath,
    status: { type: 'systemError' }, parentThreadId: null }, turns: [failure()], goal: null };
  const settings = { cwd: directory, model: 'selected-model', modelProvider: 'openai', reasoningEffort: 'high',
    approvalPolicy: 'never', sandbox: { type: 'dangerFullAccess' }, serviceTier: 'default' };
  const evidenceFile = path.join(directory, 'diagnosis.txt');
  fs.writeFileSync(evidenceFile, 'Operator diagnosis: embedded image history caused the failed request.');
  const permit = { schemaVersion: 1, confirmedCause: 'embedded-image-history', threadId: id, failedTurnId: failedId,
    errorSha256: sha256(JSON.stringify(record.turns[0].error)), identity: repairIdentity(record.thread),
    settings: resumeSettings(settings), evidence: pinFile(evidenceFile) };
  const client = new EventEmitter(), calls = [];
  let children = [], archiveError = false, startError = false, onMethod;
  client.call = async (method, params) => {
    calls.push({ method, params: clone(params) }); onMethod?.(method, params);
    if (method === 'thread/read') return { thread: clone(record.thread) };
    if (method === 'thread/turns/list') return { data: clone(record.turns) };
    if (method === 'thread/goal/get') return { goal: clone(record.goal) };
    if (method === 'thread/resume') return { ...clone(settings), thread: clone(record.thread) };
    if (method === 'thread/list') return { data: params.ancestorThreadId ? children : params.archived && record.thread.archived ? [clone(record.thread)] : [] };
    if (method === 'thread/loaded/list') return { data: record.thread.archived ? [] : [id] };
    if (method === 'thread/archive') {
      if (archiveError) throw Error('Transport closed; archive receipt lost');
      const next = path.join(archives, path.basename(sourcePath));
      fs.renameSync(record.thread.path, next); record.thread.path = next; record.thread.archived = true;
      return {};
    }
    if (method === 'thread/unarchive') {
      fs.renameSync(record.thread.path, sourcePath); record.thread.path = sourcePath; record.thread.archived = false;
      return { thread: clone(record.thread) };
    }
    if (method === 'thread/compact/start') {
      const turn = { id: 'compaction', status: 'completed', error: null };
      record.turns.unshift(turn);
      queueMicrotask(() => {
        client.emit('notification', { method: 'turn/started', params: { threadId: id, turn: { ...turn, status: 'inProgress' } } });
        client.emit('notification', { method: 'item/completed', params: { threadId: id, turnId: turn.id, item: { type: 'contextCompaction' } } });
        client.emit('notification', { method: 'turn/completed', params: { threadId: id, turn } });
      });
      return {};
    }
    if (method === 'turn/start') {
      if (startError) throw Error('Receipt lost');
      record.turns.unshift({ id: 'continued', status: 'inProgress' }); record.thread.status.type = 'active';
      return { turn: clone(record.turns[0]) };
    }
    throw Error('Unexpected RPC ' + method);
  };
  const snapshot = async () => clone(record);
  const initial = clone(record);
  exclusiveJson(confirmationPath(directory, id, failedId), permit);
  const replace = async job => {
    assert.equal(sha256(fs.readFileSync(job.archivePath)), job.manifest.sourceSha256);
    fs.copyFileSync(job.archivePath, job.backupPath, fs.constants.COPYFILE_EXCL);
    fs.copyFileSync(job.manifest.outputPath, job.archivePath);
    return { status: 'verified', appliedSha256: job.manifest.outputSha256, backupSha256: job.manifest.sourceSha256 };
  };
  const run = options => repairImageHistory({ client, directory, initial, snapshot, codexHome,
    allowed: async () => true, replace, ...options });
  return { directory, codexHome, sourcePath, original, record, settings, permit, evidenceFile, client, calls, initial, run,
    setChildren(value) { children = value; }, loseArchive() { archiveError = true; }, loseStart() { startError = true; },
    onMethod(value) { onMethod = value; } };
}

test('Bad Request and image presence alone never authorize history mutation', async t => {
  const f = fixture(t); fs.unlinkSync(confirmationPath(f.directory, id, failedId));
  assert.equal((await f.run()).action, 'image-cause-unconfirmed');
  assert.equal(hasMutation(f.calls), false); assert.deepEqual(fs.readFileSync(f.sourcePath), f.original);
  f.permit.confirmedCause = 'capacity';
  assert.equal(permitDecision(f.initial, f.permit), 'confirmation-does-not-match');
  assert.equal(imageFailure({ ...failure(), error: { codexErrorInfo: 'serverOverloaded', message: 'Bad Request' } }), false);
});
test('a capacity failure cannot reuse a prior image diagnosis', async t => {
  const f = fixture(t); f.initial.turns[0].error = { codexErrorInfo: 'serverOverloaded', message: 'At capacity' };
  assert.equal((await f.run()).action, 'not-image-failure-candidate'); assert.equal(hasMutation(f.calls), false);
});
test('confirmation belongs to the exact failed turn, identity, and unmodified evidence', async t => {
  const f = fixture(t);
  assert.equal(permitDecision({ ...f.initial, turns: [{ ...failure(), id: 'later' }] }, f.permit), 'confirmation-does-not-match');
  assert.equal(permitDecision({ ...f.initial, thread: { ...f.initial.thread, cwd: 'elsewhere' } }, f.permit), 'confirmation-does-not-match');
  fs.writeFileSync(f.evidenceFile, 'changed');
  assert.equal((await f.run()).action, 'confirmation-evidence-unavailable'); assert.equal(hasMutation(f.calls), false);
});
test('active, paused/blocked/active goals, excluded and native owners are untouched', async t => {
  const f = fixture(t);
  for (const status of ['active', 'paused', 'blocked', 'complete', 'budgetLimited']) {
    assert.equal(imageSafety({ ...f.initial, goal: { status } }), 'goal-history-repair-not-supported');
  }
  assert.equal(imageSafety(f.initial, [id]), 'excluded');
  assert.equal(imageSafety({ ...f.initial, turns: [{ id: 'new', status: 'inProgress' }] }), 'active');
  assert.equal(imageSafety({ ...f.initial, thread: { ...f.initial.thread, canAcceptDirectInput: false } }), 'not-ordinary-direct-input');
  assert.equal((await f.run({ allowed: async () => false })).action, 'config-stopped'); assert.equal(hasMutation(f.calls), false);
});
test('repair preserves all record offsets and originals, compacts, and continues same owner once', async t => {
  const f = fixture(t); const result = await f.run();
  assert.equal(result.action, 'image-recovery-accepted');
  const restored = fs.readFileSync(f.sourcePath);
  assert.equal(restored.length, f.original.length);
  const content = JSON.parse(restored.toString()).payload.content;
  assert.deepEqual(content[0], { type: 'input_text', text: '日本語の依頼を維持する。' });
  assert.equal(content[1].type, 'input_text'); assert.match(content[1].text, /保存済み画像参照/);
  const archive = path.join(f.codexHome, 'archived_sessions');
  const backup = fs.readdirSync(archive).find(n => n.startsWith('.image-original-'));
  assert.deepEqual(fs.readFileSync(path.join(archive, backup)), f.original);
  const start = f.calls.find(c => c.method === 'turn/start');
  assert.equal(start.params.threadId, id);
  assert.deepEqual(Object.keys(start.params).sort(), ['clientUserMessageId', 'input', 'threadId']);
  assert.ok(f.calls.filter(c => c.method === 'thread/resume').every(c =>
    JSON.stringify(c.params) === JSON.stringify({ threadId: id, excludeTurns: true })));
  assert.equal(f.calls.some(c => c.method === 'thread/goal/set'), false);
  const again = await f.run(); assert.equal(again.action, 'image-episode-already-recorded');
  assert.equal(f.calls.filter(c => c.method === 'turn/start').length, 1);
});
test('live descendants prevent archive, so other owners are not affected', async t => {
  const f = fixture(t); f.setChildren([{ id: 'child' }]);
  await f.run(); assert.equal(f.calls.some(c => c.method === 'thread/archive'), false);
  assert.deepEqual(fs.readFileSync(f.sourcePath), f.original);
});
test('a stop at archive dispatch and a known rejected replacement never leave a hidden task', async t => {
  const f = fixture(t); let allowed = true, scopeReads = 0;
  f.onMethod((method, params) => {
    if (method === 'thread/list' && params.ancestorThreadId && ++scopeReads === 2) allowed = false;
  });
  await f.run({ allowed: async () => allowed });
  assert.equal(f.calls.some(c => c.method === 'thread/archive'), false);
  const g = fixture(t);
  const result = await g.run({ replace: async () => { const error = Error('Source changed'); error.notReplaced = true; throw error; } });
  assert.equal(result.action, 'aborted-restored'); assert.equal(g.record.thread.archived, false);
  assert.deepEqual(fs.readFileSync(g.sourcePath), g.original);
  assert.equal(g.calls.some(c => c.method === 'thread/compact/start' || c.method === 'turn/start'), false);
});
test('unknown archive and continuation outcomes remain fenced without replay', async t => {
  for (const stage of ['archive', 'start']) {
    const f = fixture(t); stage === 'archive' ? f.loseArchive() : f.loseStart();
    assert.equal((await f.run()).action, 'unknown-or-aborted-no-resend');
    await f.run();
    const method = stage === 'archive' ? 'thread/archive' : 'turn/start';
    assert.equal(f.calls.filter(c => c.method === method).length, 1);
  }
});
test('revocation or permission change prevents subsequent compaction/start', async t => {
  const f = fixture(t);
  f.onMethod(method => { if (method === 'thread/unarchive') f.settings.approvalPolicy = 'on-request'; });
  await f.run(); assert.equal(f.calls.some(c => c.method === 'thread/compact/start'), false);
  assert.equal(f.calls.some(c => c.method === 'turn/start'), false);
  const g = fixture(t);
  g.onMethod(method => { if (method === 'thread/compact/start') fs.unlinkSync(confirmationPath(g.directory, id, failedId)); });
  assert.equal((await g.run()).action, 'changed-after-compaction-no-start');
  assert.equal(g.calls.some(c => c.method === 'turn/start'), false);
});
test('a compaction receipt is not completion, and unrelated turn events cannot complete it', async () => {
  const client = new EventEmitter(); let complete = false;
  client.call = async () => ({});
  const work = compactImages(client, id, () => {}).then(value => { complete = true; return value; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(complete, false);
  client.emit('notification', { method: 'turn/completed', params: { threadId: 'other', turn: { id: 'no', status: 'completed' } } });
  assert.equal(complete, false);
  client.emit('notification', { method: 'turn/started', params: { threadId: id, turn: { id: 'compact' } } });
  client.emit('notification', { method: 'item/completed', params: { threadId: id, turnId: 'compact', item: { type: 'contextCompaction' } } });
  client.emit('notification', { method: 'turn/completed', params: { threadId: id, turn: { id: 'compact', status: 'completed' } } });
  assert.equal((await work).id, 'compact');
});
test('confirmation requires explicit diagnosis and exact current failure', async t => {
  const f = fixture(t); fs.unlinkSync(confirmationPath(f.directory, id, failedId));
  fs.writeFileSync(path.join(f.directory, 'config.json'), JSON.stringify({ schemaVersion: 1, enabled: true,
    excludedThreadIds: [], imageHistoryRepair: true }));
  const options = { client: f.client, directory: f.directory, threadId: id, failedTurnId: failedId,
    evidenceFile: f.evidenceFile, codexHome: f.codexHome };
  await assert.rejects(confirmImageCause(options), /operator/);
  assert.equal(hasMutation(f.calls), false);
  const result = await confirmImageCause({ ...options, confirmedImageCause: true });
  assert.equal(result.action, 'confirmed-specific-image-episode');
  assert.equal(permitDecision(f.initial, JSON.parse(fs.readFileSync(result.file))), 'confirmed-image-episode');
});
test('an intentionally archived rollout is not resumed to register confirmation', async t => {
  const f = fixture(t); fs.unlinkSync(confirmationPath(f.directory, id, failedId));
  fs.writeFileSync(path.join(f.directory, 'config.json'), JSON.stringify({ schemaVersion: 1, enabled: true,
    excludedThreadIds: [], imageHistoryRepair: true }));
  f.record.thread.path = path.join(f.codexHome, 'archived_sessions', path.basename(f.sourcePath));
  await assert.rejects(confirmImageCause({ client: f.client, directory: f.directory, threadId: id,
    failedTurnId: failedId, evidenceFile: f.evidenceFile, confirmedImageCause: true, codexHome: f.codexHome }), /outside/);
  assert.equal(f.calls.some(c => c.method === 'thread/resume'), false);
});
test('native Windows replacement makes a verified backup and rejects changed source', { skip: process.platform !== 'win32' }, async t => {
  const f = fixture(t);
  const candidate = path.join(f.directory, 'candidate.jsonl');
  const manifest = await prepareImageReferences({ sourcePath: f.sourcePath, outputPath: candidate,
    assetDirectory: path.join(f.directory, 'assets') });
  const archiveRoot = path.join(f.codexHome, 'archived_sessions'), archivePath = path.join(archiveRoot, path.basename(f.sourcePath));
  fs.renameSync(f.sourcePath, archivePath);
  const job = { operationId: '33333333-3333-4333-8333-333333333333', threadId: id, manifest,
    archiveRoot, archivePath, backupPath: path.join(archiveRoot, 'backup.jsonl'), resultPath: path.join(f.directory, 'result.json') };
  const proof = await replaceArchivedImages(job, f.directory);
  assert.equal(proof.status, 'verified'); assert.deepEqual(fs.readFileSync(job.backupPath), f.original);
  assert.deepEqual(fs.readFileSync(archivePath), fs.readFileSync(candidate));
  const g = fixture(t), changedDir = path.join(g.directory, 'change-operation'); fs.mkdirSync(changedDir);
  const changedArchive = path.join(g.codexHome, 'archived_sessions', path.basename(g.sourcePath));
  fs.renameSync(g.sourcePath, changedArchive); fs.appendFileSync(changedArchive, ' ');
  const changed = fs.readFileSync(changedArchive);
  await assert.rejects(replaceArchivedImages({ ...job, archiveRoot: path.dirname(changedArchive), archivePath: changedArchive,
    backupPath: path.join(changedDir, 'backup.jsonl'), resultPath: path.join(changedDir, 'result.json') }, changedDir));
  assert.deepEqual(fs.readFileSync(changedArchive), changed); assert.equal(fs.existsSync(path.join(changedDir, 'backup.jsonl')), false);
});
