import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  assistantTextFromTurn,
  completionNoticeContent,
  completionSummary,
  completionTextFromSession,
  discordCodeBlock,
  fitsDiscordMessageContent,
  formatThreadSnapshot,
  finalTextFromTurn,
  itemResultSummary,
  isPathWithinProject,
  normalizeProjectPath,
  planDiscordCodeBlockDelivery,
  planDiscordTextDelivery,
  projectDescriptor,
  reasoningSummaryFromTurn,
  sanitizeChannelName,
  splitDiscordCodeBlocks,
  splitText,
  threadStatusLabel,
  taskChannelName,
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

test('channel names and statuses are stable for Discord display', () => {
  assert.equal(sanitizeChannelName('AER Recovery: Final Review'), 'aer-recovery-final-review');
  assert.equal(threadStatusLabel({ type: 'active', activeFlags: ['waitingOnApproval'] }), 'active: waitingOnApproval');
  assert.equal(threadStatusEmoji({ type: 'active' }), '🟢');
  assert.equal(threadStatusEmoji({ type: 'idle' }), '⚫');
  assert.equal(taskChannelName({ name: 'AER Recovery', status: { type: 'active' } }), '🟢-aer-recovery');
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
