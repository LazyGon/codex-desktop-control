import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

const BLOCKED_DIRECTORY_NAMES = new Map([
  ['.git', 'Git内部ディレクトリ'],
  ['.ssh', 'SSH秘密情報ディレクトリ'],
  ['.gnupg', 'GPG秘密情報ディレクトリ'],
  ['.aws', 'AWS認証情報ディレクトリ'],
  ['.azure', 'Azure認証情報ディレクトリ'],
  ['.kube', 'Kubernetes認証情報ディレクトリ'],
  ['.codex', 'Codexローカル認証・状態ディレクトリ'],
  ['.config', 'ユーザー設定・認証情報ディレクトリ'],
  ['node_modules', '依存関係ディレクトリ'],
]);

const BLOCKED_FILE_NAMES = new Map([
  ['token.dpapi', '暗号化されたBot token'],
  ['auth.json', '認証情報ファイル'],
  ['credentials.json', '認証情報ファイル'],
  ['client_secret.json', 'OAuth client secret'],
  ['cookies.sqlite', 'ブラウザcookieデータ'],
  ['.npmrc', 'package registry認証情報を含む可能性があるファイル'],
  ['.pypirc', 'package registry認証情報を含む可能性があるファイル'],
  ['.netrc', 'ネットワーク認証情報ファイル'],
]);

const BLOCKED_EXTENSIONS = new Map([
  ['.pem', '秘密鍵・証明書ファイル'],
  ['.key', '秘密鍵ファイル'],
  ['.pfx', '秘密鍵を含む証明書ファイル'],
  ['.p12', '秘密鍵を含む証明書ファイル'],
  ['.kdbx', 'パスワードデータベース'],
  ['.jks', 'Java key store'],
]);

const SAFE_ENV_TEMPLATES = new Set(['.env.example', '.env.sample', '.env.template']);
const PRIVATE_KEY_PATTERN = /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/;

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
  const normalized = path.win32.normalize(String(filePath ?? ''));
  const segments = normalized.split(/[\\/]+/).filter(Boolean);
  for (const segment of segments.slice(0, -1)) {
    const reason = BLOCKED_DIRECTORY_NAMES.get(segment.toLocaleLowerCase('en-US'));
    if (reason) return reason;
  }
  const name = segments.at(-1)?.toLocaleLowerCase('en-US') ?? '';
  const directoryReason = BLOCKED_DIRECTORY_NAMES.get(name);
  if (directoryReason) return directoryReason;
  const fileReason = BLOCKED_FILE_NAMES.get(name);
  if (fileReason) return fileReason;
  if (name.startsWith('.env') && !SAFE_ENV_TEMPLATES.has(name)) return '環境変数・secretファイル';
  const extensionReason = BLOCKED_EXTENSIONS.get(path.win32.extname(name));
  if (extensionReason) return extensionReason;
  if (/^(?:id_(?:rsa|dsa|ecdsa|ed25519)|.*private[-_.]?key)(?:\..*)?$/i.test(name)) return '秘密鍵ファイル';
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
    let lockedReason = blockedPathReason(relativePath);
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
  const records = [];
  const seen = new Set();
  for (const value of roots ?? []) {
    const normalized = normalizeLocalTarget(value);
    if (!normalized) continue;
    try {
      const real = await fs.promises.realpath(normalized);
      const stat = await fs.promises.stat(real);
      if (!stat.isDirectory()) continue;
      const key = normalizeCase(real);
      if (seen.has(key)) continue;
      seen.add(key);
      records.push({ normalized, real });
    } catch {}
  }
  return records;
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

async function contentSecretReason(filePath) {
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(64 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (PRIVATE_KEY_PATTERN.test(buffer.subarray(0, bytesRead).toString('utf8'))) return '秘密鍵本文を含むファイル';
    return null;
  } finally {
    await handle.close();
  }
}

export async function resolveShareFile(targetValue, roots) {
  const normalized = normalizeLocalTarget(targetValue);
  if (!normalized) throw new Error('ローカルWindows絶対パスではありません。');
  const candidate = await existingTarget(normalized);
  const originalStat = await fs.promises.lstat(candidate);
  if (originalStat.isSymbolicLink()) throw new Error('シンボリックリンクまたはjunctionはダウンロードできません。');
  if (!originalStat.isFile()) throw new Error('ディレクトリは直接ダウンロードできません。Project filesから内容を選択してください。');
  const realCandidate = await fs.promises.realpath(candidate);
  const rootRecords = await allowedRootRecords(roots);
  const root = rootRecords.find((record) => isWithin(realCandidate, record.real));
  if (!root) throw new Error('許可されたCodexプロジェクトの外にあるためダウンロードできません。');
  if (await containsPathLink(root.normalized, candidate)) {
    throw new Error('パスにシンボリックリンクまたはjunctionが含まれるためダウンロードできません。');
  }
  const relativePath = path.win32.relative(root.real, realCandidate) || path.win32.basename(realCandidate);
  const secretReason = blockedPathReason(realCandidate)
    ?? blockedPathReason(relativePath)
    ?? await contentSecretReason(realCandidate);
  if (secretReason) throw new Error(`秘密・保護対象のためダウンロードできません: ${secretReason}`);
  const stat = await fs.promises.stat(realCandidate);
  return {
    path: realCandidate,
    root: root.real,
    relativePath,
    name: path.win32.basename(realCandidate),
    size: stat.size,
    mtime: stat.mtime.toISOString(),
  };
}

export async function inspectFileTransfer(file, { chunkBytes, maxBytes }) {
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes <= 0) throw new Error('Invalid transfer chunk size.');
  if (file.size > maxBytes) throw new Error(`ファイルが転送上限を超えています (${file.size} > ${maxBytes} bytes)。`);
  const totalParts = Math.max(1, Math.ceil(file.size / chunkBytes));
  const wholeHash = createHash('sha256');
  const parts = [];
  const handle = await fs.promises.open(file.path, 'r');
  try {
    let offset = 0;
    for (let index = 0; index < totalParts; index += 1) {
      const size = file.size === 0 ? 0 : Math.min(chunkBytes, file.size - offset);
      const buffer = Buffer.alloc(size);
      if (size > 0) {
        const { bytesRead } = await handle.read(buffer, 0, size, offset);
        if (bytesRead !== size) throw new Error('ファイル読み取り中にサイズが変化しました。');
      }
      wholeHash.update(buffer);
      parts.push({
        index,
        offset,
        size,
        sha256: createHash('sha256').update(buffer).digest('hex'),
      });
      offset += size;
    }
  } finally {
    await handle.close();
  }
  const current = await fs.promises.stat(file.path);
  if (current.size !== file.size || current.mtime.toISOString() !== file.mtime) {
    throw new Error('検査中にファイルが更新されました。もう一度選択してください。');
  }
  return {
    ...file,
    chunkBytes,
    split: totalParts > 1,
    sha256: wholeHash.digest('hex'),
    parts,
  };
}

export async function readTransferPart(transfer, part) {
  const handle = await fs.promises.open(transfer.path, 'r');
  try {
    const buffer = Buffer.alloc(part.size);
    if (part.size > 0) {
      const { bytesRead } = await handle.read(buffer, 0, part.size, part.offset);
      if (bytesRead !== part.size) throw new Error('ファイル読み取り中にサイズが変化しました。');
    }
    const hash = createHash('sha256').update(buffer).digest('hex');
    if (hash !== part.sha256) throw new Error('検査後にファイル内容が変化しました。もう一度選択してください。');
    return buffer;
  } finally {
    await handle.close();
  }
}

export function safeAttachmentName(fileName, suffix = '') {
  const safeName = String(fileName).replace(/[\x00-\x1f<>:"/\\|?*]/g, '_');
  return `${safeName.slice(0, Math.max(1, 180 - suffix.length))}${suffix}`;
}

export function transferPartName(fileName, index, total) {
  const width = Math.max(3, String(total).length);
  const suffix = `.part${String(index + 1).padStart(width, '0')}-of-${String(total).padStart(width, '0')}`;
  return safeAttachmentName(fileName, suffix);
}

export function transferManifest(transfer) {
  return {
    schema: 'codex-discord-file-transfer/v1',
    format: transfer.split ? 'raw-concatenation-v1' : 'single-file-v1',
    originalName: transfer.name,
    relativePath: transfer.relativePath,
    size: transfer.size,
    modifiedAt: transfer.mtime,
    sha256: transfer.sha256,
    chunkBytes: transfer.chunkBytes,
    parts: transfer.parts.map((part) => ({
      name: transfer.split
        ? transferPartName(transfer.name, part.index, transfer.parts.length)
        : transfer.name,
      index: part.index + 1,
      offset: part.offset,
      size: part.size,
      sha256: part.sha256,
    })),
  };
}
