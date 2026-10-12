import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const sessionCompletionCache = new Map();

export function nowIso() {
  return new Date().toISOString();
}

export function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function readJsonIfPresent(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

export function atomicWriteJson(filePath, value, { space = 2 } = {}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, space)}\n`, 'utf8');
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.renameSync(temporaryPath, filePath);
      break;
    } catch (error) {
      const retryable = ['EACCES', 'EBUSY', 'EPERM'].includes(error.code);
      if (!retryable || attempt >= 39) {
        try { fs.unlinkSync(temporaryPath); } catch {}
        throw error;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
}

export function appendJsonLine(filePath, event, details = {}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify({ at: nowIso(), event, ...details })}\n`, 'utf8');
}

export function truncate(value, maximum, suffix = '...') {
  const text = String(value ?? '');
  if (text.length <= maximum) return text;
  return `${text.slice(0, Math.max(0, maximum - suffix.length))}${suffix}`;
}

export function formatReasoningField(value, maximum = 900, maximumLines = 4) {
  const limit = Math.max(1, Number(maximum) || 900);
  const lines = String(value ?? '')
    .split(/\r?\n/)
    .map((line) => line.replaceAll('**', '').trim())
    .filter(Boolean)
    .slice(-Math.max(1, Number(maximumLines) || 4));
  while (lines.length > 1 && lines.map((line) => `- ${line}`).join('\n').length > limit) {
    lines.shift();
  }
  if (lines.length === 0) return '';
  return truncate(lines.map((line) => `- ${line}`).join('\n'), limit, '…');
}

export function splitText(value, maximum = 1900) {
  const text = String(value ?? '');
  if (!text) return [];
  const chunks = [];
  let remaining = text;
  while (remaining.length > maximum) {
    let boundary = remaining.lastIndexOf('\n', maximum);
    if (boundary < Math.floor(maximum * 0.55)) boundary = remaining.lastIndexOf(' ', maximum);
    if (boundary < Math.floor(maximum * 0.4)) boundary = maximum;
    chunks.push(remaining.slice(0, boundary).trimEnd());
    remaining = remaining.slice(boundary).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

export function discordCodeBlock(value, language = 'text') {
  const escaped = String(value ?? '').replaceAll('```', '``\\`');
  return `\`\`\`${language}\n${escaped}\n\`\`\``;
}

export function fitsDiscordMessageContent(value) {
  return String(value ?? '').length <= 2000;
}

export function splitDiscordCodeBlocks(value, language = 'text') {
  const prefix = `\`\`\`${language}\n`;
  const suffix = '\n```';
  const escaped = String(value ?? '').replaceAll('```', '``\\`');
  const chunks = splitText(escaped || '(empty)', 2000 - prefix.length - suffix.length);
  return chunks.map((chunk) => `${prefix}${chunk}${suffix}`);
}

export function planDiscordCodeBlockDelivery(value, language = 'text', maximumMessages = 5) {
  const text = String(value ?? '') || '(empty)';
  const messages = splitDiscordCodeBlocks(text, language);
  if (messages.length <= maximumMessages) return { attachmentText: null, messages };
  return {
    attachmentText: text,
    messages: messages.slice(-(maximumMessages - 1)),
  };
}

export function planDiscordTextDelivery(value, maximumMessages = 5, chunkSize = 1700) {
  const text = String(value ?? '') || '(empty)';
  const messages = splitText(text, chunkSize);
  if (messages.length <= maximumMessages) return { attachmentText: null, messages };
  return {
    attachmentText: text,
    messages: messages.slice(-(maximumMessages - 1)),
  };
}

export function completionSummary(value, maximum = 280) {
  const firstLine = String(value ?? '').split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? '(要約なし)';
  const cleaned = firstLine
    .replace(/^#{1,6}\s+/, '')
    .replace(/^>\s+/, '')
    .replace(/^(?:[-*+]|\d+[.)])\s+/, '')
    .trim();
  return truncate(cleaned || '(要約なし)', maximum);
}

export function completionNoticeContent(userIds, messageUrl, finalText) {
  const mentions = [...new Set(
    (Array.isArray(userIds) ? userIds : [userIds]).filter(Boolean),
  )].map((userId) => `<@${userId}>`).join(' ');
  return `${mentions ? `${mentions} ` : ''}タスクが完了しました。\n要約: ${completionSummary(finalText)}\n${messageUrl}`;
}

export function normalizeProjectPath(value) {
  const input = String(value ?? '').trim().replaceAll('/', '\\');
  if (!path.win32.isAbsolute(input)) throw new Error('Project path must be an absolute Windows path.');
  const normalized = path.win32.normalize(input);
  return normalized.length > 3 ? normalized.replace(/\\+$/, '') : normalized;
}

export function projectPathKey(value) {
  return normalizeProjectPath(value).toLocaleLowerCase('en-US');
}

export function projectIdFromKey(projectKey) {
  return `prj_${createHash('sha256').update(String(projectKey)).digest('hex').slice(0, 12)}`;
}

export function projectCategoryName(projectName, categoryPrefix = 'Codex - ', categorySuffix = '',
  useEllipsis = Boolean(categorySuffix)) {
  return `${truncate(`${categoryPrefix}${projectName}`, 100 - categorySuffix.length,
    useEllipsis ? '…' : '')}${categorySuffix}`;
}

export function projectDescriptor(cwd, categoryPrefix = 'Codex - ', categorySuffix = '',
  useEllipsis = Boolean(categorySuffix)) {
  if (!cwd) {
    const key = '__no_project__';
    return {
      id: projectIdFromKey(key),
      key,
      path: '(no project)',
      name: projectCategoryName('No Project', categoryPrefix, categorySuffix, useEllipsis),
    };
  }
  const normalized = normalizeProjectPath(cwd);
  const projectName = path.win32.basename(normalized) || normalized.replaceAll('\\', '-');
  const key = projectPathKey(normalized);
  return {
    id: projectIdFromKey(key),
    key,
    path: normalized,
    name: projectCategoryName(projectName, categoryPrefix, categorySuffix, useEllipsis),
  };
}

export function isPathWithinProject(candidatePath, projectPath) {
  if (!candidatePath) return false;
  const candidate = projectPathKey(candidatePath);
  const project = projectPathKey(projectPath);
  const relative = path.win32.relative(project, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.win32.isAbsolute(relative));
}

export function uniqueProjectPath(bindings) {
  const projects = new Map();
  for (const binding of bindings ?? []) {
    if (!binding?.cwd) continue;
    try {
      const normalized = normalizeProjectPath(binding.cwd);
      projects.set(projectPathKey(normalized), normalized);
    } catch {}
  }
  return projects.size === 1 ? [...projects.values()][0] : null;
}

export function sanitizeChannelName(value, fallback = 'task') {
  const normalized = String(value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
  return truncate(normalized || fallback, 78, '');
}

export function threadStatusLabel(status) {
  if (typeof status === 'string') return status;
  if (!status?.type) return 'unknown';
  if (status.type !== 'active') return status.type;
  const flags = status.activeFlags?.length ? `: ${status.activeFlags.join(', ')}` : '';
  return `active${flags}`;
}

export function threadStatusEmoji(status) {
  return status?.type === 'active' ? '🟢' : '⚫';
}

export function taskChannelName(thread) {
  const title = thread?.name ?? thread?.preview ?? thread?.id?.slice(0, 8) ?? 'task';
  return `${threadStatusEmoji(thread?.status)}-${sanitizeChannelName(title)}`;
}

export function itemSummary(item) {
  if (!item) return 'unknown item';
  switch (item.type) {
    case 'commandExecution':
      return `command: ${truncate(item.command, 700)}`;
    case 'fileChange': {
      const paths = (item.changes ?? []).map((change) => change.path).filter(Boolean);
      return `file change: ${truncate(paths.join(', ') || item.status || 'pending', 700)}`;
    }
    case 'mcpToolCall':
      return `MCP ${item.server}/${item.tool}`;
    case 'dynamicToolCall':
      return `tool ${item.namespace ? `${item.namespace}/` : ''}${item.tool}`;
    case 'collabAgentToolCall':
      return `agent ${item.tool}: ${(item.receiverThreadIds ?? []).join(', ') || item.status}`;
    case 'subAgentActivity':
      return `subagent ${item.agentPath}: ${item.kind}`;
    case 'webSearch':
      return `web search: ${truncate(item.query, 700)}`;
    case 'imageView':
      return `image: ${item.path}`;
    case 'imageGeneration':
      return `image generation: ${item.status}`;
    case 'sleep':
      return `wait ${Math.round(item.durationMs / 1000)}s`;
    case 'contextCompaction':
      return 'context compacted';
    case 'agentMessage':
      return `${item.phase ?? 'assistant'} message`;
    default:
      return item.type ?? 'unknown item';
  }
}

export function itemResultSummary(item) {
  const base = itemSummary(item);
  if (item?.type === 'commandExecution') {
    const suffix = item.exitCode === null || item.exitCode === undefined ? item.status : `exit ${item.exitCode}`;
    return `${base} (${suffix})`;
  }
  if (item?.status) return `${base} (${item.status})`;
  return base;
}

export function assistantTextFromTurn(turn, preferredPhase = null) {
  const messages = (turn?.items ?? []).filter((item) => item.type === 'agentMessage' && item.text);
  if (preferredPhase) {
    const preferred = messages.filter((item) => item.phase === preferredPhase);
    return preferred.map((item) => item.text).join('\n\n');
  }
  return messages.map((item) => item.text).join('\n\n');
}

export function completionTextFromSession(sessionPath, turnId) {
  if (!sessionPath || !turnId) return '';
  try {
    const stat = fs.statSync(sessionPath);
    let cached = sessionCompletionCache.get(sessionPath);
    const sameFile = cached && cached.dev === stat.dev && cached.ino === stat.ino;
    const unchanged = sameFile && cached.offset === stat.size
      && cached.mtimeMs === stat.mtimeMs && cached.ctimeMs === stat.ctimeMs;
    if (unchanged) return cached.provisional?.get(turnId) ?? cached.messages.get(turnId) ?? '';

    // Session JSONL files are append-only in normal operation. On growth, verify
    // the old EOF bytes before trusting that assumption; on same-size metadata
    // changes, replacement, or truncation, rebuild the cache from byte zero.
    let rebuild = !sameFile || stat.size < (cached?.offset ?? 0);
    if (cached && sameFile && stat.size === cached.offset
      && (cached.mtimeMs !== stat.mtimeMs || cached.ctimeMs !== stat.ctimeMs)) rebuild = true;
    if (cached && sameFile && stat.size > cached.offset && !rebuild) {
      const anchor = cached.anchor;
      if (anchor.length) {
        const fd = fs.openSync(sessionPath, 'r');
        try {
          const actual = Buffer.alloc(anchor.length);
          const read = fs.readSync(fd, actual, 0, actual.length, cached.offset - anchor.length);
          if (read !== anchor.length || !actual.equals(anchor)) rebuild = true;
        } finally {
          fs.closeSync(fd);
        }
      }
    }

    if (!cached || rebuild) {
      cached = {
        dev: stat.dev,
        ino: stat.ino,
        mtimeMs: stat.mtimeMs,
        ctimeMs: stat.ctimeMs,
        offset: 0,
        messages: new Map(),
        pending: [],
        pendingLength: 0,
        provisional: null,
        anchor: Buffer.alloc(0),
      };
    }

    let snapshotAnchor = cached.anchor;
    const fd = fs.openSync(sessionPath, 'r');
    try {
      const chunkSize = SESSION_COMPLETION_CHUNK_SIZE;
      const chunk = Buffer.allocUnsafe(chunkSize);
      while (cached.offset < stat.size) {
        const wanted = Math.min(chunkSize, stat.size - cached.offset);
        const read = fs.readSync(fd, chunk, 0, wanted, cached.offset);
        if (read <= 0) break;
        const bytes = chunk.subarray(0, read);
        consumeCompletionBytes(cached, bytes);
        snapshotAnchor = appendCompletionAnchor(snapshotAnchor, bytes);
        cached.offset += read;
      }
    } finally {
      fs.closeSync(fd);
    }
    const after = fs.statSync(sessionPath);
    let snapshotChanged = after.dev !== stat.dev || after.ino !== stat.ino
      || after.size < cached.offset || after.size < stat.size
      || (after.size === stat.size
        && (after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs));
    if (!snapshotChanged && after.size > cached.offset && snapshotAnchor.length) {
      snapshotChanged = !readCompletionAnchor(sessionPath, cached.offset).equals(snapshotAnchor);
    }
    if (snapshotChanged) {
      // Do not attach a mixed or replaced snapshot to this path. The next
      // lookup will rebuild from zero.
      sessionCompletionCache.delete(sessionPath);
      return '';
    }
    cached.dev = after.dev;
    cached.ino = after.ino;
    cached.mtimeMs = after.mtimeMs;
    cached.ctimeMs = after.ctimeMs;
    cached.anchor = snapshotAnchor;
    cached.provisional = parseProvisionalCompletion(cached.pending, cached.pendingLength);
    sessionCompletionCache.set(sessionPath, cached);
    return cached.provisional?.get(turnId) ?? cached.messages.get(turnId) ?? '';
  } catch {
    return '';
  }
}

const SESSION_COMPLETION_CHUNK_SIZE = 64 * 1024;
const SESSION_COMPLETION_ANCHOR_SIZE = 64;

function consumeCompletionBytes(cached, bytes) {
  let start = 0;
  while (start < bytes.length) {
    const newline = bytes.indexOf(0x0a, start);
    if (newline < 0) {
      const tail = bytes.subarray(start);
      // The caller reuses its bounded read buffer for the next chunk.
      cached.pending.push(Buffer.from(tail));
      cached.pendingLength += tail.length;
      return;
    }
    const linePart = bytes.subarray(start, newline);
    const lineBuffers = cached.pending.length ? [...cached.pending, linePart] : [linePart];
    const line = Buffer.concat(lineBuffers, cached.pendingLength + linePart.length);
    cached.pending = [];
    cached.pendingLength = 0;
    recordCompletionLine(cached.messages, line);
    start = newline + 1;
  }
}

function recordCompletionLine(messages, bytes) {
  if (!bytes.length) return;
  let line = bytes;
  if (line.at(-1) === 0x0d) line = line.subarray(0, -1);
  if (!line.length) return;
  try {
    const entry = JSON.parse(line.toString('utf8'));
    const payload = entry?.type === 'event_msg' ? entry.payload : null;
    if (payload?.type === 'task_complete' && payload.turn_id && payload.last_agent_message) {
      messages.set(payload.turn_id, payload.last_agent_message);
    }
  } catch {
    // Ignore malformed and incomplete JSONL records, as the old full scan did.
  }
}

function parseProvisionalCompletion(pending, pendingLength) {
  if (!pendingLength) return null;
  const messages = new Map();
  recordCompletionLine(messages, Buffer.concat(pending, pendingLength));
  return messages.size ? messages : null;
}

function readCompletionAnchor(sessionPath, offset) {
  const length = Math.min(SESSION_COMPLETION_ANCHOR_SIZE, offset);
  if (!length) return Buffer.alloc(0);
  const fd = fs.openSync(sessionPath, 'r');
  try {
    const anchor = Buffer.alloc(length);
    const read = fs.readSync(fd, anchor, 0, length, offset - length);
    return read === length ? anchor : anchor.subarray(0, read);
  } finally {
    fs.closeSync(fd);
  }
}

function appendCompletionAnchor(anchor, bytes) {
  if (bytes.length >= SESSION_COMPLETION_ANCHOR_SIZE) {
    return Buffer.from(bytes.subarray(-SESSION_COMPLETION_ANCHOR_SIZE));
  }
  const combined = Buffer.concat([anchor, bytes]);
  return combined.length > SESSION_COMPLETION_ANCHOR_SIZE
    ? combined.subarray(-SESSION_COMPLETION_ANCHOR_SIZE)
    : combined;
}

export function needsSessionCompletionFallback(turn) {
  return !(turn?.items ?? []).some((item) => item.type === 'agentMessage'
    && item.phase === 'final_answer' && item.text);
}

export function finalTextFromTurn(turn, completionText = '') {
  const messages = (turn?.items ?? []).filter((item) => item.type === 'agentMessage' && item.text);
  const final = messages.filter((item) => item.phase === 'final_answer');
  if (final.length) return final.map((item) => item.text).join('\n\n').trimEnd();
  if (completionText) return completionText.trimEnd();
  return messages.at(-1)?.text?.trimEnd() ?? '';
}

export function reasoningSummaryFromTurn(turn) {
  const summaries = (turn?.items ?? [])
    .filter((item) => item.type === 'reasoning')
    .flatMap((item) => item.summary ?? [])
    .map((value) => String(value).trim())
    .filter(Boolean);
  return [...new Set(summaries)].join('\n');
}

export function recentMessagesFromThread(thread, limit = 16, characterLimit = 6000) {
  const messages = [];
  for (const turn of thread?.turns ?? []) {
    for (const item of turn.items ?? []) {
      if (item.type === 'agentMessage' && item.text) {
        messages.push({ role: 'assistant', text: truncate(item.text, characterLimit), turnId: turn.id, phase: item.phase });
      }
      if (item.type === 'userMessage') {
        const text = (item.content ?? []).map((part) => part.text ?? '').filter(Boolean).join('\n');
        if (text) messages.push({ role: 'user', text: truncate(text, characterLimit), turnId: turn.id });
      }
    }
  }
  return messages.slice(-limit);
}

export function formatThreadSnapshot(thread, limit = 16) {
  const header = [
    `Task: ${thread.name ?? '(untitled)'}`,
    `ID: ${thread.id}`,
    `Status: ${threadStatusLabel(thread.status)}`,
    `CWD: ${thread.cwd ?? '(none)'}`,
    '',
  ].join('\n');
  const body = recentMessagesFromThread(thread, limit)
    .map((message) => `[${message.role}${message.phase ? `/${message.phase}` : ''}]\n${message.text}`)
    .join('\n\n');
  return `${header}${body || '(no messages)'}`;
}

export function isSnowflake(value) {
  return /^\d{15,22}$/.test(String(value ?? ''));
}

export function randomKey(length = 12) {
  return crypto.randomUUID().replaceAll('-', '').slice(0, length);
}

export function deepClone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}
