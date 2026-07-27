import fs from 'node:fs';
import path from 'node:path';

function normalizeCase(value) {
  return path.win32.normalize(value).toLocaleLowerCase('en-US');
}

function isWithin(candidate, root) {
  const relative = path.win32.relative(normalizeCase(root), normalizeCase(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.win32.isAbsolute(relative));
}

function decodeTarget(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function normalizeLocalTarget(value) {
  let target = String(value ?? '').trim();
  if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1).trim();
  if (/^file:\/\/\//i.test(target)) target = decodeTarget(target.replace(/^file:\/\/\//i, ''));
  if (/^\/[a-z]:[\\/]/i.test(target)) target = target.slice(1);
  target = decodeTarget(target);
  if (/^\\\\/.test(target) || !/^[a-z]:[\\/]/i.test(target)) return null;
  const extraColons = target.slice(2).match(/:/g)?.length ?? 0;
  if (extraColons > 0 && !/:\d+(?::\d+)?$/.test(target)) return null;
  return path.win32.normalize(target.replaceAll('/', '\\'));
}

export function extractLocalFileReferences(markdown) {
  const text = String(markdown ?? '');
  const references = [];
  const seen = new Set();
  const opener = /!?\[([^\]\r\n]*)\]\(/g;
  let match;
  while ((match = opener.exec(text))) {
    const targetStart = opener.lastIndex;
    let depth = 1;
    let inAngle = false;
    let escaped = false;
    let cursor = targetStart;
    for (; cursor < text.length; cursor += 1) {
      const character = text[cursor];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === '\\') {
        escaped = true;
        continue;
      }
      if (character === '<') inAngle = true;
      else if (character === '>') inAngle = false;
      else if (!inAngle && character === '(') depth += 1;
      else if (!inAngle && character === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    if (depth !== 0) break;
    opener.lastIndex = cursor + 1;
    const rawTarget = text.slice(targetStart, cursor).trim();
    const targetPath = normalizeLocalTarget(rawTarget);
    if (!targetPath) continue;
    const key = normalizeCase(targetPath);
    if (seen.has(key)) continue;
    seen.add(key);
    references.push({
      label: match[1].trim() || path.win32.basename(targetPath),
      target: targetPath,
    });
  }
  return references;
}

export function blockedPathReason(filePath) {
  const normalized = normalizeLocalTarget(filePath);
  if (!normalized) return null;
  const systemRoot = normalizeLocalTarget(process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows');
  const systemDrive = path.win32.parse(systemRoot ?? normalized).root;
  const protectedRoots = [
    systemRoot,
    path.win32.join(systemDrive, 'System Volume Information'),
    path.win32.join(systemDrive, '$Recycle.Bin'),
    path.win32.join(systemDrive, 'Recovery'),
    path.win32.join(systemDrive, 'Program Files', 'WindowsApps'),
  ].filter(Boolean);
  if (protectedRoots.some((root) => isWithin(normalized, root))) {
    return 'Windows保護領域';
  }
  return null;
}

function safeRelativeDirectory(value) {
  const input = String(value ?? '').trim().replaceAll('/', '\\');
  if (!input || input === '.') return '';
  if (path.win32.isAbsolute(input)) throw new Error('プロジェクト内の相対パスが必要です。');
  const normalized = path.win32.normalize(input).replace(/^\.\\/, '');
  if (normalized === '..' || normalized.startsWith('..\\')) throw new Error('プロジェクト外へは移動できません。');
  return normalized;
}

async function realDirectoryRoot(rootPath) {
  const normalized = normalizeLocalTarget(rootPath);
  if (!normalized) throw new Error('タスクの作業フォルダが有効なWindows絶対パスではありません。');
  const real = await fs.promises.realpath(normalized);
  const stat = await fs.promises.stat(real);
  if (!stat.isDirectory()) throw new Error('タスクの作業フォルダがディレクトリではありません。');
  return { normalized, real };
}

export async function listProjectDirectory(rootPath, relativeDirectory = '') {
  const root = await realDirectoryRoot(rootPath);
  const relative = safeRelativeDirectory(relativeDirectory);
  const requested = path.win32.resolve(root.normalized, relative);
  if (!isWithin(requested, root.normalized)) throw new Error('プロジェクト外へは移動できません。');
  const realDirectory = await fs.promises.realpath(requested);
  if (!isWithin(realDirectory, root.real)) throw new Error('リンク先がプロジェクト外のため表示できません。');
  const stat = await fs.promises.stat(realDirectory);
  if (!stat.isDirectory()) throw new Error('選択したパスはディレクトリではありません。');

  const directoryEntries = await fs.promises.readdir(realDirectory, { withFileTypes: true });
  const entries = await Promise.all(directoryEntries.map(async (entry) => {
    const absolutePath = path.win32.join(realDirectory, entry.name);
    const relativePath = path.win32.join(relative, entry.name);
    let kind = entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other';
    let size = null;
    let lockedReason = blockedPathReason(absolutePath);
    try {
      const entryStat = await fs.promises.lstat(absolutePath);
      if (entryStat.isSymbolicLink()) {
        kind = 'link';
        lockedReason = 'シンボリックリンクまたはjunction';
      } else if (entryStat.isFile()) {
        size = entryStat.size;
      } else if (!entryStat.isDirectory()) {
        lockedReason ??= '通常ファイル・ディレクトリではない項目';
      }
    } catch {
      lockedReason = 'ファイル情報を読み取れない項目';
    }
    return {
      name: entry.name,
      relativePath,
      kind,
      size,
      lockedReason,
      navigable: kind === 'directory' && !lockedReason,
      downloadable: kind === 'file' && !lockedReason,
    };
  }));
  entries.sort((left, right) => {
    const leftRank = left.kind === 'directory' ? 0 : left.kind === 'file' ? 1 : 2;
    const rightRank = right.kind === 'directory' ? 0 : right.kind === 'file' ? 1 : 2;
    return leftRank - rightRank || left.name.localeCompare(right.name, undefined, { sensitivity: 'base' });
  });
  return {
    root: root.real,
    relativeDirectory: relative,
    entries,
  };
}

async function existingTarget(target) {
  const withoutLocation = target.replace(/:(\d+)(?::\d+)?$/, '');
  const candidates = [withoutLocation];
  for (const candidate of candidates) {
    try {
      await fs.promises.lstat(candidate);
      return candidate;
    } catch {}
  }
  throw new Error('ファイルが存在しないか、現在は読み取れません。');
}

async function allowedRootRecords(roots) {
  const records = new Map();
  for (const value of roots ?? []) {
    const rootPath = typeof value === 'string' ? value : value?.path;
    const normalized = normalizeLocalTarget(rootPath);
    if (!normalized) continue;
    try {
      const real = await fs.promises.realpath(normalized);
      const stat = await fs.promises.stat(real);
      if (!stat.isDirectory()) continue;
      const key = normalizeCase(real);
      if (!records.has(key)) records.set(key, { normalized, real });
    } catch {}
  }
  return [...records.values()];
}

async function containsPathLink(root, candidate) {
  if (!isWithin(candidate, root)) return true;
  const relative = path.win32.relative(root, candidate);
  let cursor = root;
  for (const segment of relative.split('\\').filter(Boolean)) {
    cursor = path.win32.join(cursor, segment);
    const stat = await fs.promises.lstat(cursor);
    if (stat.isSymbolicLink()) return true;
  }
  return false;
}

export async function resolveShareFile(targetValue, roots) {
  const normalized = normalizeLocalTarget(targetValue);
  if (!normalized) throw new Error('ローカルWindows絶対パスではありません。');
  const candidate = await existingTarget(normalized);
  const originalStat = await fs.promises.lstat(candidate);
  if (originalStat.isSymbolicLink()) throw new Error('シンボリックリンクまたはjunctionはダウンロードできません。');
  if (!originalStat.isFile()) throw new Error('ディレクトリは直接ダウンロードできません。Project filesから内容を選択してください。');
  const realCandidate = await fs.promises.realpath(candidate);
  const protectedReason = blockedPathReason(realCandidate);
  if (protectedReason) {
    throw new Error(`Windows保護領域のためダウンロードできません: ${protectedReason}`);
  }
  const rootRecords = await allowedRootRecords(roots);
  const root = rootRecords.find((record) => isWithin(realCandidate, record.real));
  const traversalRoot = path.win32.parse(candidate).root;
  if (await containsPathLink(traversalRoot, candidate)) {
    throw new Error('パスにシンボリックリンクまたはjunctionが含まれるためダウンロードできません。');
  }
  const resolvedRoot = root?.real ?? path.win32.dirname(realCandidate);
  const relativePath = root
    ? path.win32.relative(root.real, realCandidate) || path.win32.basename(realCandidate)
    : path.win32.basename(realCandidate);
  const stat = await fs.promises.stat(realCandidate);
  return {
    path: realCandidate,
    root: resolvedRoot,
    relativePath,
    name: path.win32.basename(realCandidate),
    size: stat.size,
    mtime: stat.mtime.toISOString(),
  };
}

export function safeAttachmentName(fileName, suffix = '') {
  const safeName = String(fileName).replace(/[\x00-\x1f<>:"/\\|?*]/g, '_');
  return `${safeName.slice(0, Math.max(1, 180 - suffix.length))}${suffix}`;
}
