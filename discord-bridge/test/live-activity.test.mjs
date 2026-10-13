import test from 'node:test';
import assert from 'node:assert/strict';
import {
  activityCellWidth, liveActivityItemText, liveActivityWindow,
  publicReasoningText, recordLiveActivity, restoreLiveActivity, wrapActivityRows,
} from '../src/live-activity.mjs';

const contentRows = value => value.split('\n').slice(1, -1);

test('the activity frame has five rows from empty to full, not five entries', () => {
  for (const entries of [[], ['one'], ['one', 'two'], ['one', 'two', 'three', 'four', 'five', 'six']]) {
    assert.equal(contentRows(liveActivityWindow(entries)).length, 5);
  }
  assert.deepEqual(contentRows(liveActivityWindow(['one', 'two', 'three', 'four', 'five', 'six'])),
    ['two', 'three', 'four', 'five', 'six']);
  assert.equal(contentRows(liveActivityWindow(['one']))[0], 'one');
});

test('one long command retains its header plus the latest rows within the five-row frame', () => {
  const command = 'abcdefghij'.repeat(30);
  const rows = wrapActivityRows(command);
  assert.ok(rows.length > 5);
  assert.equal(rows.join(''), command);
  const continued = wrapActivityRows(command, 48, { continuationPrefix: '  ↳ ' });
  const shown = contentRows(liveActivityWindow(['old command', command]));
  assert.deepEqual(shown, [continued[0], continued.at(-4).replace(/^  ↳ /u, '  … '), ...continued.slice(-3)]);
  assert.equal(shown[0].startsWith('  ↳ '), false);
  assert.ok(shown.slice(2).every(row => row.startsWith('  ↳ ')));
  assert.deepEqual(contentRows(liveActivityWindow(['git status', 'git diff', 'npm test'])).slice(0, 3),
    ['git status', 'git diff', 'npm test']);
});

test('leading status icons and unchanged continuation markers distinguish new work from wrapped lines', () => {
  const rows = contentRows(liveActivityWindow(['検討 First line\nSecond line', '▶️ npm test', '✅ git diff']));
  assert.deepEqual(rows.slice(0, 4), ['検討 First line', '  ↳ Second line', '▶️ npm test', '✅ git diff']);
  const long = contentRows(liveActivityWindow(['▶️ ' + '日本語👨‍👩‍👧‍👦'.repeat(40)]));
  const segments = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  assert.ok(long[0].startsWith('▶️ '));
  assert.ok(long[1].startsWith('  … '));
  assert.ok(long.slice(2).every(row => row.startsWith('  ↳ ')));
  assert.ok(long.every(row => [...segments.segment(row)]
    .reduce((cells, { segment }) => cells + activityCellWidth(segment), 0) <= 48));
});

test('partial older entries keep their own header and latest result, never an orphaned tail', () => {
  const older = '✅ npm test\nsetup\nprepare\nrun\nreport\nexit 0';
  assert.deepEqual(contentRows(liveActivityWindow([older, '▶️ git diff'])),
    ['✅ npm test', '  … run', '  ↳ report', '  ↳ exit 0', '▶️ git diff']);
  const crowded = contentRows(liveActivityWindow([older, 'one', 'two', 'three', 'four']));
  assert.deepEqual(crowded.slice(0, 4), ['one', 'two', 'three', 'four']);
  assert.equal(crowded[4], '\u200b');
  assert.deepEqual(contentRows(liveActivityWindow(['older', 'npm test\nexit 0', 'one', 'two'])),
    ['older', 'npm test', '  ↳ exit 0', 'one', 'two']);
});

test('generic node_repl rows are omitted while their public action titles are useful activity', () => {
  for (const item of [
    { type: 'mcpToolCall', server: 'node_repl', tool: 'js', arguments: { code: 'PRIVATE' } },
    { type: 'dynamicToolCall', namespace: 'node_repl', tool: 'js_reset' },
    { type: 'mcpToolCall', server: 'mcp__node_repl', tool: 'js', arguments: '{invalid' },
    { type: 'dynamicToolCall', tool: 'mcp__node_repl__js' },
  ]) {
    assert.equal(liveActivityItemText(item), '');
    assert.equal(liveActivityItemText(item, true), '');
  }
  const labelled = { type: 'mcpToolCall', server: 'node_repl', tool: 'js',
    arguments: { title: '表示の折り返しを確認', code: 'PRIVATE', key: 'PRIVATE' } };
  assert.equal(liveActivityItemText(labelled), '▶️ 表示の折り返しを確認');
  assert.equal(liveActivityItemText({ ...labelled, arguments: JSON.stringify(labelled.arguments) }, true),
    '✅ 表示の折り返しを確認');
  assert.equal(liveActivityItemText({ type: 'mcpToolCall', server: 'other', tool: 'js' }), '▶️ ツール other/js');
  const view = {};
  restoreLiveActivity(view, [{ ...labelled, id: 'labelled' },
    { id: 'generic', type: 'mcpToolCall', server: 'node_repl', tool: 'js' }]);
  const output = liveActivityWindow(view.activityEntries);
  assert.match(output, /表示の折り返しを確認/);
  assert.equal(output.includes('node_repl'), false);
  assert.equal(output.includes('PRIVATE'), false);
});

test('wrapping counts CJK and emoji cells without splitting graphemes or command syntax', () => {
  assert.equal(activityCellWidth('日'), 2);
  assert.equal(activityCellWidth('👨‍👩‍👧‍👦'), 2);
  assert.equal(activityCellWidth('🇯🇵'), 2);
  assert.equal(activityCellWidth('1️⃣'), 2);
  assert.equal(activityCellWidth('e\u0301'), 1);
  const text = '日本語👨‍👩‍👧‍👦 e\u0301'.repeat(40);
  const rows = wrapActivityRows(text);
  const segments = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  assert.equal(rows.join(''), text);
  assert.ok(rows.every(row => [...segments.segment(row)]
    .reduce((cells, { segment }) => cells + activityCellWidth(segment), 0) <= 48));
  assert.ok(rows.every(row => !row.endsWith('\u200d') && !row.startsWith('\u0301')));
  assert.deepEqual(wrapActivityRows('first\r\nsecond\rthird'), ['first', 'second', 'third']);
});

test('code fences and control characters cannot grow or escape the Discord field', () => {
  const value = liveActivityWindow(['```\n@everyone\n```\n\u0000']);
  assert.equal((value.match(/```/g) ?? []).length, 2);
  assert.equal(contentRows(value).length, 5);
  assert.ok(value.length <= 1024);
  const combining = liveActivityWindow(['a' + '\u0301'.repeat(5000)]);
  assert.ok(combining.length <= 1024);
  const dense = liveActivityWindow(['👨‍👩‍👧‍👦'.repeat(1000)]);
  assert.ok(dense.length <= 1024);
});

test('streamed updates replace the same entry and actual tool progress shares the window', () => {
  const view = {};
  recordLiveActivity(view, 'summary', '検討 Reviewing');
  recordLiveActivity(view, 'summary', '検討 Reviewing layout');
  recordLiveActivity(view, 'command', liveActivityItemText({ type: 'commandExecution', command: 'git diff' }));
  assert.equal(view.activityEntries.length, 2);
  assert.match(liveActivityWindow(view.activityEntries), /Reviewing layout/);
  assert.match(liveActivityWindow(view.activityEntries), /git diff/);
  recordLiveActivity(view, 'command', liveActivityItemText({ type: 'commandExecution', command: 'git diff', exitCode: 1 }, true));
  assert.equal(view.activityEntries.length, 2);
  assert.match(liveActivityWindow(view.activityEntries), /❌ git diff/);
  assert.match(liveActivityWindow(view.activityEntries), /exit 1/);
});

test('only public summary and tool identity are rendered, never raw reasoning or arguments', () => {
  const item = { type: 'reasoning', summary: ['**Public section**', { text: 'Public explanation' }], content: ['PRIVATE'] };
  assert.equal(publicReasoningText(item.summary), '**Public section**\nPublic explanation');
  assert.equal(liveActivityItemText(item), '検討 Public section\nPublic explanation');
  assert.equal(liveActivityItemText({ type: 'mcpToolCall', server: 'tools', tool: 'search', arguments: { secret: 'PRIVATE' } }), '▶️ ツール tools/search');
  const view = {};
  restoreLiveActivity(view, [{ ...item, id: 'reasoning' }, { id: 'tool', type: 'commandExecution', command: 'npm test', status: 'inProgress' }]);
  const output = liveActivityWindow(view.activityEntries);
  assert.match(output, /Public explanation/);
  assert.match(output, /npm test/);
  assert.equal(output.includes('PRIVATE'), false);
});

test('only leading status uses icons while work types use readable text', () => {
  for (const [item, label] of [
    [{ type: 'fileChange', changes: [{ path: 'app.mjs' }] }, 'ファイル変更 app.mjs'],
    [{ type: 'collabAgentToolCall', tool: 'spawn_agent' }, '子タスク spawn_agent'],
    [{ type: 'subAgentActivity', agentPath: 'worker', kind: 'interacted' }, '子タスク worker interacted'],
    [{ type: 'webSearch', query: 'release' }, '検索 release'],
    [{ type: 'imageView', path: 'image.png' }, '画像確認 image.png'],
    [{ type: 'imageGeneration' }, '画像生成'],
    [{ type: 'sleep', durationMs: 1000 }, '待機 1s'],
    [{ type: 'contextCompaction' }, 'コンテキスト整理'],
  ]) {
    assert.equal(liveActivityItemText(item), `▶️ ${label}`);
    assert.equal(liveActivityItemText(item, true), `✅ ${label}`);
    assert.equal(liveActivityItemText({ ...item, status: 'failed' }, true), `❌ ${label}`);
    assert.equal(liveActivityItemText({ ...item, status: 'declined' }, true), `❌ 拒否 ${label}`);
    assert.equal(/👥|🔎|✏️|🖼️|🗜️/u.test(liveActivityItemText(item)), false);
  }
  assert.equal(contentRows(liveActivityWindow())[0], '▶️');
});
