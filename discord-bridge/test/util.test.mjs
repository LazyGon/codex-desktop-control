import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  assistantTextFromTurn,
  atomicWriteJson,
  completionNoticeContent,
  completionSummary,
  completionTextFromSession,
  discordCodeBlock,
  fitsDiscordMessageContent,
  formatThreadSnapshot,
  formatReasoningField,
  finalTextFromTurn,
  itemResultSummary,
  needsSessionCompletionFallback,
  isPathWithinProject,
  normalizeProjectPath,
  planDiscordCodeBlockDelivery,
  planDiscordTextDelivery,
  projectCategoryName,
  projectDescriptor,
  reasoningSummaryFromTurn,
  sanitizeChannelName,
  splitDiscordCodeBlocks,
  splitText,
  threadStatusLabel,
  taskChannelName,
  taskThreadForDisplay,
  threadStatusEmoji,
  uniqueProjectPath,
} from '../src/util.mjs';

test('splitText preserves all text within the requested chunk size', () => {
  const source = `${'alpha '.repeat(80)}\n${'beta '.repeat(80)}`;
  const chunks = splitText(source, 120);
  assert.ok(chunks.length > 2);
  assert.ok(chunks.every((chunk) => chunk.length <= 120));
  assert.equal(chunks.join(' ').replace(/\s+/g, ' ').trim(), source.replace(/\s+/g, ' ').trim());
});

test('reasoning fields show recent parts as bounded plain bullets', () => {
  assert.equal(
    formatReasoningField('**First step**\nSecond step\n**Third step**'),
    '- First step\n- Second step\n- Third step',
  );
  assert.equal(
    formatReasoningField('one\ntwo\nthree\nfour\nfive'),
    '- two\n- three\n- four\n- five',
  );
  const long = formatReasoningField(`**${'word '.repeat(250)}**`, 120);
  assert.ok(long.length <= 120);
  assert.ok(long.startsWith('- word'));
  assert.equal(long.includes('**'), false);
});

test('channel names and statuses are stable for Discord display', () => {
  assert.equal(sanitizeChannelName('AER Recovery: Final Review'), 'aer-recovery-final-review');
  assert.equal(threadStatusLabel({ type: 'active', activeFlags: ['waitingOnApproval'] }), 'active: waitingOnApproval');
  assert.equal(threadStatusEmoji({ type: 'active' }), '🟢');
  assert.equal(threadStatusEmoji({ type: 'idle' }), '⚫');
  assert.equal(threadStatusEmoji({ type: 'systemError' }), '🔴');
  assert.equal(threadStatusEmoji('failed'), '🔴');
  assert.equal(threadStatusEmoji({ type: 'active', activeFlags: ['waitingOnUserInput'] }), '🟢');
  assert.equal(taskChannelName({ name: 'AER Recovery', status: { type: 'active' } }), '🟢-aer-recovery');
});

test('failed task display survives idle metadata but clears on actual recovery', () => {
  const binding = { taskStatus: 'systemError' };
  const thread = { id: 'task', name: 'Test', status: { type: 'idle' } };
  assert.equal(taskChannelName(taskThreadForDisplay(thread, binding)), '🔴-test');
  assert.equal(taskChannelName(taskThreadForDisplay({ ...thread, status: { type: 'active' } }, binding)), '🟢-test');
  assert.equal(taskChannelName(taskThreadForDisplay({ ...thread, turns: [{ status: 'failed' }] })), '🔴-test');
  for (const status of ['completed', 'interrupted']) {
    assert.equal(taskChannelName(taskThreadForDisplay({ ...thread, turns: [{ status }] }, binding)), '⚫-test');
  }
  assert.equal(taskThreadForDisplay(thread, { taskStatus: 'idle' }), thread);
});

test('Discord inline payloads include wrapper and escaping in the 2000 character limit', () => {
  const shortPayload = discordCodeBlock('a'.repeat(1900));
  assert.equal(fitsDiscordMessageContent(shortPayload), true);
  const escapedPayload = discordCodeBlock('```'.repeat(500));
  assert.equal(fitsDiscordMessageContent(escapedPayload), false);
  assert.equal(fitsDiscordMessageContent('a'.repeat(2001)), false);
});

test('long Discord code blocks are split into valid message payloads', () => {
  const chunks = splitDiscordCodeBlocks(`${'長文'.repeat(1500)}\n${'```'.repeat(200)}`);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => fitsDiscordMessageContent(chunk)));
  assert.ok(chunks.every((chunk) => chunk.startsWith('```text\n') && chunk.endsWith('\n```')));
});

test('Discord delivery plans cap long output at five messages with a full attachment', () => {
  const value = 'section\n'.repeat(3000);
  const codePlan = planDiscordCodeBlockDelivery(value);
  assert.equal(codePlan.attachmentText, value);
  assert.equal(codePlan.messages.length, 4);
  assert.ok(codePlan.messages.every((message) => fitsDiscordMessageContent(message)));

  const textPlan = planDiscordTextDelivery(value);
  assert.equal(textPlan.attachmentText, value);
  assert.equal(textPlan.messages.length, 4);
  assert.ok(textPlan.messages.every((message) => message.length <= 1700));
});

test('completion notices lead with completion, then summary, and end with a bare Discord message URL', () => {
  const content = completionNoticeContent(
    ['123456789012345678', '222222222222222222', '123456789012345678'],
    'https://discord.com/channels/guild/channel/message',
    '# Implemented the requested Discord behavior\n\nMore detail.',
  );
  assert.equal(
    content,
    '<@123456789012345678> <@222222222222222222> タスクが完了しました。\n要約: Implemented the requested Discord behavior\nhttps://discord.com/channels/guild/channel/message',
  );
  assert.equal(completionSummary('- First result\nSecond result'), 'First result');
  assert.ok(!content.includes('[メッセージリンク]'));
  assert.equal(
    completionNoticeContent([], 'https://discord.test/message', 'Done.'),
    'タスクが完了しました。\n要約: Done.\nhttps://discord.test/message',
  );
});

test('project paths are normalized and include descendant working directories', () => {
  assert.equal(normalizeProjectPath('C:/git/example/'), 'C:\\git\\example');
  assert.equal(isPathWithinProject('c:\\GIT\\example', 'C:\\git\\example'), true);
  assert.equal(isPathWithinProject('C:\\git\\example\\packages\\api', 'C:\\git\\example'), true);
  assert.equal(isPathWithinProject('C:\\git\\example-other', 'C:\\git\\example'), false);
  assert.throws(() => normalizeProjectPath('relative/project'), /absolute Windows path/);
  assert.equal(uniqueProjectPath([{ cwd: 'C:\\git\\example' }, { cwd: 'c:/GIT/example/' }]), 'c:\\GIT\\example');
  assert.equal(uniqueProjectPath([{ cwd: 'C:\\git\\one' }, { cwd: 'C:\\git\\two' }]), null);
});

test('turn snapshots select assistant final text and project descriptors are stable', () => {
  const turn = {
    id: 'turn-1',
    status: 'completed',
    items: [
      { type: 'agentMessage', phase: 'commentary', text: 'working' },
      { type: 'agentMessage', phase: 'final_answer', text: 'done' },
    ],
  };
  assert.equal(assistantTextFromTurn(turn, 'final_answer'), 'done');
  assert.equal(assistantTextFromTurn(turn, 'analysis'), '');
  assert.equal(finalTextFromTurn(turn), 'done');
  assert.equal(needsSessionCompletionFallback(turn), false);
  assert.equal(needsSessionCompletionFallback({ items: [{ type: 'agentMessage', phase: 'commentary', text: 'working' }] }), true);
  assert.equal(needsSessionCompletionFallback({ items: [{ type: 'agentMessage', phase: 'final_answer', text: '' }] }), true);
  assert.equal(finalTextFromTurn({ items: [{ type: 'agentMessage', phase: 'commentary', text: 'last public update' }] }), 'last public update');
  assert.equal(finalTextFromTurn(turn, 'session completion'), 'done');
  assert.equal(finalTextFromTurn({ items: [{ type: 'agentMessage', phase: 'commentary', text: 'stale update' }] }, 'session completion'), 'session completion');
  assert.equal(finalTextFromTurn({ items: [] }, 'session completion\n\n'), 'session completion');
  assert.equal(reasoningSummaryFromTurn({ items: [{ type: 'reasoning', summary: ['one', 'one', 'two'] }] }), 'one\ntwo');
  assert.match(formatThreadSnapshot({ id: 'task-1', name: 'Task', status: { type: 'idle' }, cwd: 'C:/work', turns: [turn] }), /done/);
  assert.deepEqual(projectDescriptor('C:/git/Example'), {
    id: 'prj_35574e3c6147',
    key: 'c:\\git\\example',
    path: 'C:\\git\\Example',
    name: 'Codex - Example',
  });
  assert.equal(projectDescriptor('C:/git/Example', 'Codex - ', ' [Alias]').name,
    'Codex - Example [Alias]');
  const longCategory = projectCategoryName('x'.repeat(200), 'Codex - ', ' [Alias]');
  assert.equal(longCategory.length, 100);
  assert.match(longCategory, /^Codex - x+… \[Alias\]$/);
  assert.equal(projectDescriptor('C:/git/Example', 'Codex [Alias] Task - ', '', true).name,
    'Codex [Alias] Task - Example');
  const longPcFirstCategory = projectCategoryName('x'.repeat(200), 'Codex [Alias] Task - ', '', true);
  assert.equal(longPcFirstCategory.length, 100);
  assert.match(longPcFirstCategory, /^Codex \[Alias\] Task - x+…$/);
  assert.match(itemResultSummary({ type: 'commandExecution', command: 'npm test', exitCode: 0 }), /exit 0/);
});

test('session completion text follows appended task_complete events', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-session-completion-'));
  const sessionPath = path.join(directory, 'session.jsonl');
  try {
    fs.writeFileSync(sessionPath, `${JSON.stringify({
      type: 'event_msg',
      payload: { type: 'task_complete', turn_id: 'turn-1', last_agent_message: 'first completion' },
    })}\n`, 'utf8');
    assert.equal(completionTextFromSession(sessionPath, 'turn-1'), 'first completion');
    assert.equal(completionTextFromSession(sessionPath, 'missing'), '');

    fs.appendFileSync(sessionPath, `${JSON.stringify({
      type: 'event_msg',
      payload: { type: 'task_complete', turn_id: 'turn-2', last_agent_message: 'second completion' },
    })}\n`, 'utf8');
    assert.equal(completionTextFromSession(sessionPath, 'turn-2'), 'second completion');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('atomicWriteJson preserves pretty output by default and supports compact output', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-atomic-json-'));
  const filePath = path.join(directory, 'state.json');
  const value = { state: 'ready', count: 2 };
  try {
    atomicWriteJson(filePath, value);
    assert.equal(fs.readFileSync(filePath, 'utf8'), `${JSON.stringify(value, null, 2)}\n`);
    atomicWriteJson(filePath, value, { space: 0 });
    assert.equal(fs.readFileSync(filePath, 'utf8'), `${JSON.stringify(value)}\n`);
    assert.deepEqual(fs.readdirSync(directory), ['state.json']);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('session completion append reads only new bytes and keeps the cache on unchanged calls', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-session-incremental-'));
  const sessionPath = path.join(directory, 'session.jsonl');
  const event = (turnId, message) => `${JSON.stringify({
    type: 'event_msg',
    payload: { type: 'task_complete', turn_id: turnId, last_agent_message: message },
  })}\n`;
  try {
    const initial = event('turn-1', 'older result').repeat(100);
    fs.writeFileSync(sessionPath, initial, 'utf8');
    assert.equal(completionTextFromSession(sessionPath, 'turn-1'), 'older result');

    const originalReadSync = fs.readSync;
    let bytesRead = 0;
    fs.readSync = function (...args) {
      const result = originalReadSync.apply(this, args);
      bytesRead += result;
      return result;
    };
    try {
      const appended = event('turn-1', 'newest result');
      fs.appendFileSync(sessionPath, appended, 'utf8');
      assert.equal(completionTextFromSession(sessionPath, 'turn-1'), 'newest result');
      assert.ok(bytesRead <= Buffer.byteLength(appended) + 128,
        `warm append read ${bytesRead} bytes for ${Buffer.byteLength(appended)} appended bytes`);
      const afterAppendReads = bytesRead;
      assert.equal(completionTextFromSession(sessionPath, 'turn-1'), 'newest result');
      assert.equal(bytesRead, afterAppendReads, 'unchanged lookup should use the cached result');
    } finally {
      fs.readSync = originalReadSync;
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('session completion retains a snapshot when another process appends during the read', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-session-concurrent-append-'));
  const sessionPath = path.join(directory, 'session.jsonl');
  const event = (message) => `${JSON.stringify({
    type: 'event_msg',
    payload: { type: 'task_complete', turn_id: 'turn-concurrent', last_agent_message: message },
  })}\n`;
  try {
    fs.writeFileSync(sessionPath, event('old result').repeat(100), 'utf8');
    assert.equal(completionTextFromSession(sessionPath, 'turn-concurrent'), 'old result');
    const firstAppend = event('first concurrent result');
    const secondAppend = event('second concurrent result');
    fs.appendFileSync(sessionPath, firstAppend, 'utf8');

    const originalReadSync = fs.readSync;
    let appendedDuringRead = false;
    let bytesRead = 0;
    fs.readSync = function (...args) {
      if (!appendedDuringRead) {
        appendedDuringRead = true;
        fs.appendFileSync(sessionPath, secondAppend, 'utf8');
      }
      const result = originalReadSync.apply(this, args);
      bytesRead += result;
      return result;
    };
    try {
      assert.equal(completionTextFromSession(sessionPath, 'turn-concurrent'), 'first concurrent result');
      const afterSnapshotReads = bytesRead;
      assert.equal(completionTextFromSession(sessionPath, 'turn-concurrent'), 'second concurrent result');
      assert.ok(bytesRead - afterSnapshotReads <= Buffer.byteLength(secondAppend) + 64,
        'the next lookup should read only the concurrent append and its prior-EOF anchor');
    } finally {
      fs.readSync = originalReadSync;
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('session completion handles malformed lines, CRLF, and a valid final JSON record without newline', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-session-pending-'));
  const sessionPath = path.join(directory, 'session.jsonl');
  const event = JSON.stringify({
    type: 'event_msg',
    payload: { type: 'task_complete', turn_id: 'turn-crlf', last_agent_message: 'CRLF result' },
  });
  const finalEvent = JSON.stringify({
    type: 'event_msg',
    payload: { type: 'task_complete', turn_id: 'turn-final', last_agent_message: '完了' },
  });
  try {
    fs.writeFileSync(sessionPath, `${'x'.repeat(70_000)}\n${event}\r\n${finalEvent}`, 'utf8');
    assert.equal(completionTextFromSession(sessionPath, 'turn-crlf'), 'CRLF result');
    assert.equal(completionTextFromSession(sessionPath, 'turn-final'), '完了');
    assert.equal(completionTextFromSession(sessionPath, 'turn-final'), '完了');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('session completion tolerates UTF-8 split across appends and promotes the provisional record on newline', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-session-utf8-'));
  const sessionPath = path.join(directory, 'session.jsonl');
  const text = JSON.stringify({
    type: 'event_msg',
    payload: { type: 'task_complete', turn_id: 'turn-utf8', last_agent_message: '完了' },
  });
  const bytes = Buffer.from(text, 'utf8');
  const split = bytes.indexOf(Buffer.from('了')) + 1;
  try {
    fs.writeFileSync(sessionPath, bytes.subarray(0, split));
    assert.equal(completionTextFromSession(sessionPath, 'turn-utf8'), '');
    fs.appendFileSync(sessionPath, bytes.subarray(split));
    assert.equal(completionTextFromSession(sessionPath, 'turn-utf8'), '完了');
    fs.appendFileSync(sessionPath, '\n');
    assert.equal(completionTextFromSession(sessionPath, 'turn-utf8'), '完了');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('session completion rebuilds after truncation and same-size rewrite', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-session-rebuild-'));
  const sessionPath = path.join(directory, 'session.jsonl');
  const event = (message) => `${JSON.stringify({
    type: 'event_msg',
    payload: { type: 'task_complete', turn_id: 'turn-rewrite', last_agent_message: message },
  })}\n`;
  try {
    const first = event('first');
    const second = event('other');
    assert.equal(Buffer.byteLength(first), Buffer.byteLength(second));
    fs.writeFileSync(sessionPath, first, 'utf8');
    assert.equal(completionTextFromSession(sessionPath, 'turn-rewrite'), 'first');
    fs.writeFileSync(sessionPath, second, 'utf8');
    const changed = new Date(Date.now() + 3000);
    fs.utimesSync(sessionPath, changed, changed);
    assert.equal(completionTextFromSession(sessionPath, 'turn-rewrite'), 'other');

    fs.writeFileSync(sessionPath, `${event('growth rewrite')}${'x'.repeat(100)}`, 'utf8');
    assert.equal(completionTextFromSession(sessionPath, 'turn-rewrite'), 'growth rewrite');

    fs.writeFileSync(sessionPath, 'broken', 'utf8');
    assert.equal(completionTextFromSession(sessionPath, 'turn-rewrite'), '');
    fs.writeFileSync(sessionPath, event('after truncation'), 'utf8');
    assert.equal(completionTextFromSession(sessionPath, 'turn-rewrite'), 'after truncation');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('session completion discards a snapshot when the path is replaced during the read', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-session-race-'));
  const sessionPath = path.join(directory, 'session.jsonl');
  const event = (turnId, message) => `${JSON.stringify({
    type: 'event_msg',
    payload: { type: 'task_complete', turn_id: turnId, last_agent_message: message },
  })}\n`;
  try {
    fs.writeFileSync(sessionPath, event('turn-race', 'old snapshot'), 'utf8');
    const originalReadSync = fs.readSync;
    let replaced = false;
    fs.readSync = function (...args) {
      if (!replaced) {
        replaced = true;
        fs.unlinkSync(sessionPath);
        fs.writeFileSync(sessionPath, event('turn-race', 'replacement'), 'utf8');
      }
      return originalReadSync.apply(this, args);
    };
    try {
      assert.equal(completionTextFromSession(sessionPath, 'turn-race'), '');
    } finally {
      fs.readSync = originalReadSync;
    }
    assert.equal(completionTextFromSession(sessionPath, 'turn-race'), 'replacement');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
