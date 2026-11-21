import test from 'node:test';
import assert from 'node:assert/strict';
import { selectCandidates } from './sweep-policy.mjs';
import { ownership } from './thread-data.mjs';
import { scrub } from './process-data.mjs';

const now = Date.parse('2026-11-21T12:00:00Z');
const base = { startedAt: '2026-11-19T00:00:00.000Z', privateBytes: 1024,
  workingSetBytes: 512, cpuSeconds: 1, sessionId: 1, commandLine: 'node worker.mjs' };
const repl = { ...base, pid: 100, parentPid: 20, name: 'node_repl.exe', executablePath: 'C:/tools/node_repl.exe' };
const node = { ...base, pid: 101, parentPid: 100, name: 'node.exe', executablePath: 'C:/Users/a/AppData/Local/OpenAI/Codex/runtimes/cua_node/bin/node.exe' };
const thread = { status: 'idle', goalStatus: 'complete', latestTurnStatus: 'completed', lastTurnEndedAt: '2026-11-20T00:00:00Z' };
function fixture(rows = [repl, node]) {
  return { report: { processes: rows.map(p => ({ ...p, threadId: 'task-a', thread: { ...thread } })),
    safety: { plan: [], autopilotPid: 999 } },
    before: { capturedAt: '2026-11-21T11:59:40Z', processes: structuredClone(rows) },
    after: { capturedAt: '2026-11-21T12:00:00Z', processes: structuredClone(rows) } };
}
const selected = f => selectCandidates(f.report, f.before, f.after, now).map(p => p.pid);
test('idle completed thread yields descendants before repl', () => assert.deepEqual(selected(fixture()), [101, 100]));
for (const [name, alter] of [
  ['active thread', f => { f.report.processes[0].thread.status = 'active'; }],
  ['not loaded', f => { f.report.processes[0].thread.status = 'notLoaded'; }],
  ['unknown thread', f => { f.report.processes[0].threadId = null; }],
  ['active goal', f => { f.report.processes[0].thread.goalStatus = 'active'; }],
  ['unknown goal', f => { f.report.processes[0].thread.goalStatus = 'unknown'; }],
  ['recent turn', f => { f.report.processes[0].thread.lastTurnEndedAt = '2026-11-21T10:00:00Z'; }],
  ['missing turn time', f => { f.report.processes[0].thread.lastTurnEndedAt = null; }],
  ['running RVM worker', f => { f.report.safety.plan = ['task-a']; }],
  ['unreadable plan', f => { f.report.safety.planError = 'denied'; }],
  ['unreadable autopilot', f => { f.report.safety.lockError = 'denied'; }],
  ['autopilot child', f => { f.report.safety.autopilotPid = 100; }],
  ['CPU increased', f => { f.after.processes[1].cpuSeconds += 1; }],
  ['PID reused', f => { f.after.processes[1].startedAt = '2026-11-21T11:00:00Z'; }],
  ['insufficient sample', f => { f.after.capturedAt = '2026-11-21T11:59:41Z'; }],
]) test(`protect ${name}`, () => { const f = fixture(); alter(f); assert.deepEqual(selected(f), []); });
for (const name of ['codex.exe', 'ChatGPT.exe', 'WUDFHost.exe', 'claude.exe', 'CodexDiscordRemoteHost.exe']) {
  test(`protect group with ${name}`, () => {
    const child = { ...node, pid: 102, parentPid: 101, name, executablePath: `C:/tools/${name}` };
    assert.deepEqual(selected(fixture([repl, node, child])), []);
  });
}
test('tsc protected even when momentarily quiet', () => {
  const f = fixture(); f.after.processes[1].commandLine = 'node --max-old-space-size=8192 C:/repo/node_modules/typescript/bin/tsc';
  assert.deepEqual(selected(f), []);
});
test('one-hour quiet orphan is eligible with identified completed owner', () => {
  const orphan = { ...base, pid: 200, parentPid: 300, name: 'git.exe', executablePath: 'C:/Git/bin/git.exe' };
  assert.deepEqual(selected(fixture([orphan])), [200]);
});
test('unknown orphan is protected', () => {
  const orphan = { ...base, pid: 200, parentPid: 300, name: 'git.exe', executablePath: 'C:/Git/bin/git.exe' };
  const f = fixture([orphan]); f.report.processes[0].threadId = null;
  assert.deepEqual(selected(f), []);
});
test('live parent prevents orphan selection', () => {
  const orphan = { ...base, pid: 200, parentPid: 300, name: 'git.exe', executablePath: 'C:/Git/bin/git.exe' };
  const parent = { ...base, pid: 300, name: 'other.exe', executablePath: 'C:/other.exe', parentPid: 0 };
  assert.deepEqual(selected(fixture([orphan, parent])), []);
});
test('shared codex ancestry without thread evidence stays unknown', () => {
  const codex = { ...base, pid: 20, parentPid: 0, name: 'codex.exe', executablePath: 'C:/codex.exe' };
  assert.equal(ownership(node, [node, repl, codex]).threadId, null);
});
test('environment evidence binds exact repl owner; conflicting IDs are rejected', () => {
  const r = { ...repl, environmentThreadId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' };
  assert.equal(ownership(node, [node, r]).threadId, r.environmentThreadId);
  const n = { ...node, environmentThreadId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' };
  assert.equal(ownership(n, [n, r]).threadId, null);
});
test('shared-server inherited environment cannot identify a thread', () => {
  const id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const codex = { ...base, pid: 20, parentPid: 0, name: 'codex.exe', executablePath: 'C:/codex.exe',
    commandLine: 'codex app-server --listen ws://127.0.0.1:8798', environmentThreadId: id };
  assert.equal(ownership(node, [node, { ...repl, environmentThreadId: id }, codex]).threadId, null);
});
test('descendant owned by another thread protects the group', () => {
  const f = fixture(); f.report.processes[1].threadId = 'task-b';
  assert.deepEqual(selected(f), []);
});
test('repl remains eligible after this invocation confirmed its cua children exited', () => {
  const f = fixture([repl]);
  assert.deepEqual(selectCandidates(f.report, f.before, f.after, now, new Set([100])).map(p => p.pid), [100]);
});
test('a reused parent PID is not an existing original parent', () => {
  const orphan = { ...base, pid: 200, parentPid: 300, name: 'git.exe', executablePath: 'C:/Git/bin/git.exe' };
  const parent = { ...base, pid: 300, name: 'other.exe', executablePath: 'C:/other.exe', parentPid: 0, startedAt: '2026-11-20T00:00:00Z' };
  assert.deepEqual(selected(fixture([orphan, parent])), [200]);
});
test('saved command prefixes redact flag, environment and signed-URL secrets', () => {
  assert.equal(scrub('node worker.mjs --token "abc def" API_KEY=abc https://example.test/?sig=xyz&x=1'),
    'node worker.mjs --token [REDACTED] API_KEY=[REDACTED] https://example.test/?sig=[REDACTED]&x=1');
});
