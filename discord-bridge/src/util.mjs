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

export function atomicWriteJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
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

export function completionNoticeContent(userId, messageUrl, finalText) {
  return `<@${userId}> タスクが完了しました。\n要約: ${completionSummary(finalText)}\n${messageUrl}`;
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

export function projectDescriptor(cwd, categoryPrefix = 'Codex - ') {
  if (!cwd) {
    const key = '__no_project__';
    return {
      id: projectIdFromKey(key),
      key,
      path: '(no project)',
      name: truncate(`${categoryPrefix}No Project`, 100, ''),
    };
  }
  const normalized = normalizeProjectPath(cwd);
  const projectName = path.win32.basename(normalized) || normalized.replaceAll('\\', '-');
  const key = projectPathKey(normalized);
  return {
    id: projectIdFromKey(key),
    key,
    path: normalized,
    name: truncate(`${categoryPrefix}${projectName}`, 100, ''),
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
    if (!cached || cached.mtimeMs !== stat.mtimeMs || cached.size !== stat.size) {
      const messages = new Map();
      for (const line of fs.readFileSync(sessionPath, 'utf8').split(/\r?\n/)) {
        if (!line) continue;
        try {
          const entry = JSON.parse(line);
          const payload = entry?.type === 'event_msg' ? entry.payload : null;
          if (payload?.type === 'task_complete' && payload.turn_id && payload.last_agent_message) {
            messages.set(payload.turn_id, payload.last_agent_message);
          }
        } catch {
          // The final line can be incomplete while Codex is appending to the session.
        }
      }
      cached = { mtimeMs: stat.mtimeMs, size: stat.size, messages };
      sessionCompletionCache.set(sessionPath, cached);
    }
    return cached.messages.get(turnId) ?? '';
  } catch {
    return '';
  }
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
