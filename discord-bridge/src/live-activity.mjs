import { summarizeActivityCommand } from './activity-command.mjs';

// The budget is display rows, not reasoning sections or tool-call count.
export const LIVE_ACTIVITY_ROWS = 5;
export const LIVE_ACTIVITY_COLUMNS = 48;
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const emptyRow = '\u200b';

export function activityCellWidth(grapheme) {
  if (/^[\p{Mark}\p{Format}]+$/u.test(grapheme)) return 0;
  if (/\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3/u.test(grapheme)) return 2;
  const point = grapheme.codePointAt(0);
  return point >= 0x1100 && (
    point <= 0x115f || point === 0x2329 || point === 0x232a
    || (point >= 0x2e80 && point <= 0xa4cf && point !== 0x303f)
    || (point >= 0xac00 && point <= 0xd7a3)
    || (point >= 0xf900 && point <= 0xfaff)
    || (point >= 0xfe10 && point <= 0xfe19)
    || (point >= 0xfe30 && point <= 0xfe6f)
    || (point >= 0xff01 && point <= 0xff60)
    || (point >= 0xffe0 && point <= 0xffe6)
    || (point >= 0x20000 && point <= 0x3fffd)
  ) ? 2 : 1;
}

export function wrapActivityRows(text, columns = LIVE_ACTIVITY_COLUMNS, { continuationPrefix = '' } = {}) {
  const rows = [];
  const continuationCells = [...segmenter.segment(continuationPrefix)]
    .reduce((width, { segment }) => width + activityCellWidth(segment), 0);
  const safe = String(text ?? '').replaceAll('```', '``\u200b`').replaceAll('\t', '    ')
    .replace(/\r\n?|[\u0085\u2028\u2029]/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  for (const source of safe.split(/\r?\n/).filter(line => line.trim())) {
    let row = rows.length ? continuationPrefix : '';
    let cells = rows.length ? continuationCells : 0;
    const tokens = [];
    let word = [];
    for (const { segment } of segmenter.segment(source)) {
      // Discord embed fields are capped at 1024 UTF-16 code units. Bound each
      // row too, including pathological combining sequences, without splitting
      // an emoji, surrogate pair, or combining grapheme.
      const display = segment.length > 190 ? '�' : segment;
      // Keep Latin words and command tokens (flags, identifiers, paths) whole.
      // Japanese text and emoji keep their existing grapheme-level wrapping.
      if (/^[\x21-\x7e\p{Script=Latin}\p{Mark}]+$/u.test(display)) word.push(display);
      else {
        if (word.length) tokens.push(word);
        word = [];
        tokens.push([display]);
      }
    }
    if (word.length) tokens.push(word);
    const nextRow = () => {
      if (row) rows.push(row);
      row = continuationPrefix;
      cells = continuationCells;
    };
    for (const token of tokens) {
      const tokenWidth = token.reduce((width, part) => width + activityCellWidth(part), 0);
      const tokenLength = token.reduce((length, part) => length + part.length, 0);
      const prefix = rows.length ? continuationPrefix : '';
      if (row.length > prefix.length
        && (cells + tokenWidth > columns || row.length + tokenLength > 190)) nextRow();
      // Only a token exceeding a complete row needs grapheme-level splitting.
      for (const display of token) {
        const width = activityCellWidth(display);
        if (cells + width > columns || row.length + display.length > 190) nextRow();
        row += display;
        cells += width;
      }
    }
    if (row) rows.push(row);
  }
  return rows;
}

export function liveActivityWindow(entries = []) {
  const rows = [];
  for (const entry of [...entries].reverse()) {
    const remaining = LIVE_ACTIVITY_ROWS - rows.length;
    if (!remaining) break;
    const wrapped = wrapActivityRows(entry.text ?? entry, LIVE_ACTIVITY_COLUMNS,
      { continuationPrefix: '  ↳ ' });
    if (wrapped.length > remaining) {
      // Never show an orphaned tail: retain this entry's command/action header.
      // One remaining row cannot show both the header and a clipping marker;
      // omit that older entry rather than make a partial command look complete.
      if (remaining === 1) break;
      const tail = wrapped.slice(-(remaining - 1));
      // Same-width prefix, so the row/field budgets and graphemes stay intact.
      tail[0] = tail[0].replace(/^  ↳ /u, '  … ');
      rows.unshift(wrapped[0], ...tail);
    } else rows.unshift(...wrapped);
  }
  if (!rows.length) rows.push('▶️');
  while (rows.length < LIVE_ACTIVITY_ROWS) rows.push(emptyRow);
  return `\`\`\`text\n${rows.join('\n')}\n\`\`\``;
}

export function recordLiveActivity(view, key, text) {
  if (!String(text ?? '').trim()) return;
  view.activityEntries ??= [];
  const existing = view.activityEntries.findIndex(entry => entry.key === key);
  if (existing >= 0) view.activityEntries.splice(existing, 1);
  view.activityEntries.push({ key, text });
  // Every nonempty entry occupies at least one row, so older entries beyond
  // the row budget cannot contribute to the visible window.
  while (view.activityEntries.length > LIVE_ACTIVITY_ROWS) view.activityEntries.shift();
}

export function publicReasoningText(summary) {
  return (Array.isArray(summary) ? summary : [])
    .map(part => typeof part === 'string' ? part : part?.text ?? '')
    .filter(part => typeof part === 'string' && part.trim())
    .join('\n');
}

function nodeReplActivityTitle(item) {
  let args = item.arguments;
  if (typeof args === 'string') {
    try { args = JSON.parse(args); } catch { return ''; }
  }
  // This known tool's title argument is the public action caption. Do not
  // display its JavaScript code, other arguments, results, or private reasoning.
  return typeof args?.title === 'string' ? args.title.trim() : '';
}

export function liveActivityItemText(item, completed = false) {
  if (!item) return '';
  const failed = item.status === 'failed' || item.status === 'declined' || item.success === false
    || (typeof item.exitCode === 'number' && item.exitCode !== 0);
  const done = completed || item.status === 'completed';
  const marker = item.status === 'declined' ? '❌ 拒否' : failed ? '❌' : done ? '✅' : '▶️';
  switch (item.type) {
    case 'reasoning': {
      const summary = publicReasoningText(item.summary).replaceAll('**', '');
      return summary ? `検討 ${summary}` : '';
    }
    case 'commandExecution':
      return `${marker} ${summarizeActivityCommand(item.command)}${done && item.exitCode != null ? `\nexit ${item.exitCode}` : ''}`;
    case 'fileChange':
      return `${marker} ファイル変更 ${(item.changes ?? []).map(change => change.path).filter(Boolean).join('\n')}`;
    case 'mcpToolCall':
    case 'dynamicToolCall': {
      const scope = item.server ?? item.namespace;
      const isNodeRepl = ['node_repl', 'mcp__node_repl'].includes(scope)
        || /^mcp__node_repl__/u.test(item.tool ?? '');
      if (isNodeRepl) {
        const title = nodeReplActivityTitle(item);
        return title ? `${marker} ${title}` : '';
      }
      return `${marker} ツール ${[scope, item.tool].filter(Boolean).join('/')}`;
    }
    case 'collabAgentToolCall':
    case 'collabToolCall':
      return `${marker} 子タスク ${item.tool ?? ''}`;
    case 'subAgentActivity':
      return `${marker} 子タスク ${item.agentPath ?? ''} ${item.kind ?? ''}`;
    case 'webSearch':
      return `${marker} 検索 ${item.query ?? item.action?.query ?? item.action?.url ?? ''}`;
    case 'imageView':
      return `${marker} 画像確認 ${item.path ?? ''}`;
    case 'imageGeneration':
      return `${marker} 画像生成`;
    case 'sleep':
      return `${marker} 待機 ${Math.round((item.durationMs ?? 0) / 1000)}s`;
    case 'contextCompaction':
      return `${marker} コンテキスト整理`;
    default:
      return '';
  }
}

export function restoreLiveActivity(view, items = []) {
  for (const item of items) {
    recordLiveActivity(view, item.id, liveActivityItemText(item));
  }
}
