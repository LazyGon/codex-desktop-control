import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { safeAttachmentName } from './local-file-share.mjs';

const TRANSFER_DIRECTORY_PREFIX = 'transfer-';

export function discover7Zip(explicitPath = null) {
  const candidates = [
    explicitPath,
    process.env.ProgramFiles ? path.join(process.env.ProgramFiles, '7-Zip', '7z.exe') : null,
    process.env['ProgramFiles(x86)'] ? path.join(process.env['ProgramFiles(x86)'], '7-Zip', '7z.exe') : null,
    'C:\\Program Files\\7-Zip\\7z.exe',
    'C:\\Program Files (x86)\\7-Zip\\7z.exe',
  ].filter(Boolean);
  return candidates.find((candidate) => path.win32.isAbsolute(candidate) && fs.existsSync(candidate)) ?? null;
}

async function sha256File(filePath) {
  const hash = createHash('sha256');
  const stream = fs.createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest('hex');
}

async function collectArchiveVolumes(directory, archiveName, archivePath, volumeBytes, maxBytes = null) {
  let volumeNames = (await fs.promises.readdir(directory))
    .filter((name) => name.startsWith(`${archiveName}.`))
    .sort((left, right) => left.localeCompare(right));
  if (volumeNames.length === 0 && fs.existsSync(archivePath)) volumeNames = [archiveName];
  if (volumeNames.length === 0) throw new Error('7-Zip did not create an archive volume.');
  if (volumeNames.length === 1 && volumeNames[0] !== archiveName) {
    await fs.promises.rename(path.join(directory, volumeNames[0]), archivePath);
    volumeNames = [archiveName];
  }
  const volumes = [];
  let archiveBytes = 0;
  for (const [index, name] of volumeNames.entries()) {
    const volumePath = path.join(directory, name);
    const stat = await fs.promises.stat(volumePath);
    if (!stat.isFile() || stat.size > volumeBytes) {
      throw new Error(`7-Zip volume is invalid or exceeds the Discord chunk size: ${name}`);
    }
    archiveBytes += stat.size;
    if (maxBytes !== null && archiveBytes > maxBytes) {
      throw new Error(`アーカイブが転送上限を超えています (${archiveBytes} > ${maxBytes} bytes)。`);
    }
    volumes.push({
      index,
      name,
      path: volumePath,
      size: stat.size,
      sha256: await sha256File(volumePath),
    });
  }
  return { volumes, archiveBytes };
}

export async function hashResolvedFile(file, maxBytes) {
  if (file.size > maxBytes) throw new Error(`ファイルが転送上限を超えています (${file.size} > ${maxBytes} bytes)。`);
  const sha256 = await sha256File(file.path);
  const current = await fs.promises.stat(file.path);
  if (current.size !== file.size || current.mtime.toISOString() !== file.mtime) {
    throw new Error('検査中にファイルが更新されました。もう一度選択してください。');
  }
  return { ...file, sha256 };
}

export async function readHashedFile(file) {
  const content = await fs.promises.readFile(file.path);
  const sha256 = createHash('sha256').update(content).digest('hex');
  if (sha256 !== file.sha256) throw new Error('検査後にファイル内容が変化しました。もう一度選択してください。');
  return content;
}

function run7Zip(executable, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const append = (chunk) => {
      output = `${output}${chunk}`.slice(-32_000);
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`7-Zip archive creation failed (exit ${code}).${output.trim() ? `\n${output.trim()}` : ''}`));
    });
  });
}

function assertManagedTransferDirectory(tempRoot, directory) {
  const relative = path.relative(path.resolve(tempRoot), path.resolve(directory));
  if (!relative || relative.includes(path.sep) || !relative.startsWith(TRANSFER_DIRECTORY_PREFIX)) {
    throw new Error('Refusing to manage a file-transfer directory outside the dedicated temporary root.');
  }
}

export async function cleanupStaleSplitArchives(tempRoot, maxAgeMs = 24 * 60 * 60_000) {
  await fs.promises.mkdir(tempRoot, { recursive: true });
  const now = Date.now();
  const entries = await fs.promises.readdir(tempRoot, { withFileTypes: true });
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(TRANSFER_DIRECTORY_PREFIX)) continue;
    const directory = path.join(tempRoot, entry.name);
    assertManagedTransferDirectory(tempRoot, directory);
    const stat = await fs.promises.stat(directory);
    if (now - stat.mtimeMs <= maxAgeMs) continue;
    await fs.promises.rm(directory, { recursive: true, force: true });
    removed += 1;
  }
  return removed;
}

export async function disposeSplitArchive(archive) {
  assertManagedTransferDirectory(archive.tempRoot, archive.directory);
  await fs.promises.rm(archive.directory, { recursive: true, force: true });
}

export async function createSplit7zArchive(file, {
  volumeBytes,
  maxBytes,
  tempRoot,
  archiverPath = null,
}) {
  if (!Number.isSafeInteger(volumeBytes) || volumeBytes <= 0) throw new Error('Invalid archive volume size.');
  const executable = discover7Zip(archiverPath);
  if (!executable) {
    throw new Error('大容量ファイルの転送には7-Zipが必要です。7z.exeをインストールするかfileShareArchiverPathを設定してください。');
  }
  const hashedFile = await hashResolvedFile(file, maxBytes);
  await fs.promises.mkdir(tempRoot, { recursive: true });
  const directory = await fs.promises.mkdtemp(path.join(tempRoot, TRANSFER_DIRECTORY_PREFIX));
  assertManagedTransferDirectory(tempRoot, directory);
  const archiveName = safeAttachmentName(file.name, '.7z');
  const archivePath = path.join(directory, archiveName);
  try {
    await run7Zip(executable, [
      'a',
      '-t7z',
      '-mx=1',
      '-bd',
      '-bso0',
      '-bsp0',
      '-y',
      `-v${volumeBytes}b`,
      archivePath,
      '--',
      path.basename(file.path),
    ], path.dirname(file.path));

    const current = await fs.promises.stat(file.path);
    if (current.size !== file.size || current.mtime.toISOString() !== file.mtime) {
      throw new Error('アーカイブ作成中にファイルが更新されました。もう一度選択してください。');
    }
    const { volumes } = await collectArchiveVolumes(directory, archiveName, archivePath, volumeBytes);
    return {
      tempRoot,
      directory,
      executable,
      format: volumes.length > 1 ? 'split-7z-v1' : 'single-7z-v1',
      volumeBytes,
      original: hashedFile,
      archiveName,
      volumes,
    };
  } catch (error) {
    await fs.promises.rm(directory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

function safeArchiveRootName(value) {
  const safe = String(value ?? '')
    .replace(/[\x00-\x1f<>:"/\\|?*]/g, '_')
    .replace(/[ .]+$/g, '')
    .trim();
  return safe || 'files';
}

function relativeArchivePath(value) {
  const normalized = path.win32.normalize(String(value ?? '')).replace(/^\.\\/, '');
  if (!normalized
    || path.win32.isAbsolute(normalized)
    || normalized === '..'
    || normalized.startsWith('..\\')
    || /[\r\n]/.test(normalized)) {
    throw new Error(`Linked file has an unsafe archive path: ${value}`);
  }
  return normalized;
}

function linkedFileArchiveEntries(files) {
  const rootNames = new Map();
  const usedRootNames = new Set();
  const seenFiles = new Set();
  const entries = [];
  for (const file of files) {
    const fileKey = path.win32.normalize(file.path).toLocaleLowerCase('en-US');
    if (seenFiles.has(fileKey)) continue;
    seenFiles.add(fileKey);
    const rootKey = path.win32.normalize(file.root).toLocaleLowerCase('en-US');
    let archiveRoot = rootNames.get(rootKey);
    if (!archiveRoot) {
      const base = safeArchiveRootName(path.win32.basename(file.root));
      archiveRoot = base;
      for (let suffix = 2; usedRootNames.has(archiveRoot.toLocaleLowerCase('en-US')); suffix += 1) {
        archiveRoot = `${base}-${suffix}`;
      }
      rootNames.set(rootKey, archiveRoot);
      usedRootNames.add(archiveRoot.toLocaleLowerCase('en-US'));
    }
    entries.push({
      file,
      archivePath: path.win32.join(archiveRoot, relativeArchivePath(file.relativePath)),
    });
  }
  return entries;
}

export async function createSplitZipArchive(files, {
  volumeBytes,
  maxBytes,
  tempRoot,
  archiverPath = null,
  archiveName = 'linked-files.zip',
}) {
  if (!Number.isSafeInteger(volumeBytes) || volumeBytes <= 0) throw new Error('Invalid archive volume size.');
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error('Invalid transfer size limit.');
  const executable = discover7Zip(archiverPath);
  if (!executable) {
    throw new Error('Downloading all linked files as ZIP requires 7-Zip. Install 7z.exe or configure fileShareArchiverPath.');
  }
  const entries = linkedFileArchiveEntries(files);
  if (entries.length === 0) throw new Error('There are no downloadable linked files.');
  const sourceBytes = entries.reduce((total, entry) => total + entry.file.size, 0);
  if (sourceBytes > maxBytes) {
    throw new Error(`Linked files exceed the transfer limit (${sourceBytes} > ${maxBytes} bytes).`);
  }
  const resolvedTempRoot = path.resolve(tempRoot);
  await fs.promises.mkdir(resolvedTempRoot, { recursive: true });
  const directory = await fs.promises.mkdtemp(path.join(resolvedTempRoot, TRANSFER_DIRECTORY_PREFIX));
  assertManagedTransferDirectory(resolvedTempRoot, directory);
  const stagingRoot = path.join(directory, 'linked-files');
  const listPath = path.join(directory, 'linked-files.utf8.lst');
  const safeArchiveName = safeAttachmentName(
    String(archiveName).toLocaleLowerCase('en-US').endsWith('.zip') ? archiveName : `${archiveName}.zip`,
  );
  const archivePath = path.join(directory, safeArchiveName);
  try {
    await fs.promises.mkdir(stagingRoot);
    const prepared = [];
    for (const entry of entries) {
      const hashed = await hashResolvedFile(entry.file, maxBytes);
      const stagedPath = path.join(stagingRoot, entry.archivePath);
      await fs.promises.mkdir(path.dirname(stagedPath), { recursive: true });
      await fs.promises.copyFile(hashed.path, stagedPath, fs.constants.COPYFILE_EXCL);
      const stagedSha256 = await sha256File(stagedPath);
      if (stagedSha256 !== hashed.sha256) {
        throw new Error(`Linked file changed while preparing the ZIP: ${hashed.relativePath}`);
      }
      const current = await fs.promises.stat(hashed.path);
      if (current.size !== hashed.size || current.mtime.toISOString() !== hashed.mtime) {
        throw new Error(`Linked file changed while preparing the ZIP: ${hashed.relativePath}`);
      }
      prepared.push({ ...hashed, archivePath: entry.archivePath });
    }
    await fs.promises.writeFile(
      listPath,
      `${prepared.map((file) => file.archivePath).join('\n')}\n`,
      'utf8',
    );
    await run7Zip(executable, [
      'a',
      '-tzip',
      '-mx=1',
      '-bd',
      '-bso0',
      '-bsp0',
      '-y',
      '-scsUTF-8',
      `-v${volumeBytes}b`,
      archivePath,
      `@${listPath}`,
    ], stagingRoot);
    const { volumes, archiveBytes } = await collectArchiveVolumes(
      directory,
      safeArchiveName,
      archivePath,
      volumeBytes,
      maxBytes,
    );
    return {
      tempRoot: resolvedTempRoot,
      directory,
      executable,
      format: volumes.length > 1 ? 'split-zip-linked-files-v1' : 'single-zip-linked-files-v1',
      volumeBytes,
      archiveName: safeArchiveName,
      archiveBytes,
      sourceBytes,
      files: prepared,
      volumes,
    };
  } catch (error) {
    await fs.promises.rm(directory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

export async function scanProjectTree(projectRoot, maxBytes) {
  const root = path.resolve(projectRoot);
  const rootStat = await fs.promises.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('プロジェクトルートは通常のディレクトリである必要があります。');
  }
  const projectName = path.basename(root);
  if (!projectName || /[\r\n]/.test(projectName)) throw new Error('プロジェクトフォルダ名をアーカイブできません。');
  const files = [];
  const skippedLinks = [];
  const skippedSpecial = [];
  const pending = [''];
  let sourceBytes = 0;
  while (pending.length > 0) {
    const relativeDirectory = pending.pop();
    const absoluteDirectory = path.join(root, relativeDirectory);
    const entries = await fs.promises.readdir(absoluteDirectory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (/[\r\n]/.test(entry.name)) throw new Error(`改行を含むファイル名はアーカイブできません: ${entry.name}`);
      const relativePath = path.join(relativeDirectory, entry.name);
      const absolutePath = path.join(root, relativePath);
      const stat = await fs.promises.lstat(absolutePath);
      if (stat.isSymbolicLink()) {
        skippedLinks.push(relativePath);
        continue;
      }
      if (stat.isDirectory()) {
        pending.push(relativePath);
        continue;
      }
      if (!stat.isFile()) {
        skippedSpecial.push(relativePath);
        continue;
      }
      sourceBytes += stat.size;
      if (sourceBytes > maxBytes) {
        throw new Error(`プロジェクトが転送上限を超えています (${sourceBytes} > ${maxBytes} bytes)。`);
      }
      files.push({
        relativePath,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      });
    }
  }
  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  if (files.length === 0) throw new Error('プロジェクトにアーカイブ可能な通常ファイルがありません。');
  return { root, projectName, files, sourceBytes, skippedLinks, skippedSpecial };
}

async function verifyProjectSnapshot(snapshot) {
  for (const file of snapshot.files) {
    const current = await fs.promises.lstat(path.join(snapshot.root, file.relativePath));
    if (!current.isFile() || current.isSymbolicLink()
      || current.size !== file.size || current.mtimeMs !== file.mtimeMs) {
      throw new Error(`アーカイブ作成中にプロジェクトファイルが更新されました: ${file.relativePath}`);
    }
  }
}

export async function createSplit7zProjectArchive(projectRoot, {
  volumeBytes,
  maxBytes,
  tempRoot,
  archiverPath = null,
}) {
  if (!Number.isSafeInteger(volumeBytes) || volumeBytes <= 0) throw new Error('Invalid archive volume size.');
  const resolvedTempRoot = path.resolve(tempRoot);
  const executable = discover7Zip(archiverPath);
  if (!executable) {
    throw new Error('プロジェクト転送には7-Zipが必要です。7z.exeをインストールするかfileShareArchiverPathを設定してください。');
  }
  const snapshot = await scanProjectTree(projectRoot, maxBytes);
  await fs.promises.mkdir(resolvedTempRoot, { recursive: true });
  const directory = await fs.promises.mkdtemp(path.join(resolvedTempRoot, TRANSFER_DIRECTORY_PREFIX));
  assertManagedTransferDirectory(resolvedTempRoot, directory);
  const archiveName = safeAttachmentName(snapshot.projectName, '.project.7z');
  const archivePath = path.join(directory, archiveName);
  const listPath = path.join(directory, 'project-files.utf8.lst');
  try {
    const list = snapshot.files
      .map((file) => path.join(snapshot.projectName, file.relativePath))
      .join('\n');
    await fs.promises.writeFile(listPath, `${list}\n`, 'utf8');
    await run7Zip(executable, [
      'a',
      '-t7z',
      '-mx=1',
      '-bd',
      '-bso0',
      '-bsp0',
      '-y',
      '-scsUTF-8',
      `-v${volumeBytes}b`,
      archivePath,
      `@${listPath}`,
    ], path.dirname(snapshot.root));
    await verifyProjectSnapshot(snapshot);
    const { volumes, archiveBytes } = await collectArchiveVolumes(
      directory,
      archiveName,
      archivePath,
      volumeBytes,
      maxBytes,
    );
    return {
      tempRoot: resolvedTempRoot,
      directory,
      executable,
      format: volumes.length > 1 ? 'split-7z-project-v1' : 'single-7z-project-v1',
      volumeBytes,
      archiveName,
      archiveBytes,
      volumes,
      project: snapshot,
    };
  } catch (error) {
    await fs.promises.rm(directory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

export async function readArchiveVolume(volume) {
  const content = await fs.promises.readFile(volume.path);
  const sha256 = createHash('sha256').update(content).digest('hex');
  if (sha256 !== volume.sha256) throw new Error(`アーカイブvolumeが送信前に変化しました: ${volume.name}`);
  return content;
}

export function splitArchiveManifest(archive) {
  return {
    schema: 'codex-discord-file-transfer/v2',
    format: archive.format,
    originalName: archive.original.name,
    relativePath: archive.original.relativePath,
    originalSize: archive.original.size,
    originalModifiedAt: archive.original.mtime,
    originalSha256: archive.original.sha256,
    archive: {
      type: '7z',
      compressionLevel: 'fast',
      entryName: path.basename(archive.original.path),
      volumeBytes: archive.volumeBytes,
      volumes: archive.volumes.map((volume) => ({
        name: volume.name,
        index: volume.index + 1,
        size: volume.size,
        sha256: volume.sha256,
      })),
    },
    extraction: archive.volumes.length > 1
      ? `Place every volume together and open ${archive.volumes[0].name} with a 7z-compatible app.`
      : `Open ${archive.volumes[0].name} with a 7z-compatible app.`,
  };
}

export function projectArchiveManifest(archive) {
  return {
    schema: 'codex-discord-project-transfer/v1',
    format: archive.format,
    projectName: archive.project.projectName,
    fileCount: archive.project.files.length,
    sourceBytes: archive.project.sourceBytes,
    includesGit: archive.project.files.some((file) => file.relativePath === '.git'
      || file.relativePath.startsWith(`.git${path.sep}`)),
    includesProtectedFiles: true,
    skippedLinks: archive.project.skippedLinks,
    skippedSpecial: archive.project.skippedSpecial,
    archive: {
      type: '7z',
      compressionLevel: 'fast',
      entryRoot: archive.project.projectName,
      size: archive.archiveBytes,
      volumeBytes: archive.volumeBytes,
      volumes: archive.volumes.map((volume) => ({
        name: volume.name,
        index: volume.index + 1,
        size: volume.size,
        sha256: volume.sha256,
      })),
    },
    extraction: archive.volumes.length > 1
      ? `Place every volume together and open ${archive.volumes[0].name} with a 7z-compatible app.`
      : `Open ${archive.volumes[0].name} with a 7z-compatible app.`,
  };
}

export function linkedFilesArchiveManifest(archive) {
  return {
    schema: 'codex-discord-linked-files-transfer/v1',
    format: archive.format,
    fileCount: archive.files.length,
    sourceBytes: archive.sourceBytes,
    files: archive.files.map((file) => ({
      relativePath: file.relativePath,
      archivePath: file.archivePath,
      size: file.size,
      modifiedAt: file.mtime,
      sha256: file.sha256,
    })),
    archive: {
      type: 'zip',
      compressionLevel: 'fast',
      size: archive.archiveBytes,
      volumeBytes: archive.volumeBytes,
      volumes: archive.volumes.map((volume) => ({
        name: volume.name,
        index: volume.index + 1,
        size: volume.size,
        sha256: volume.sha256,
      })),
    },
    extraction: archive.volumes.length > 1
      ? `Place every volume together and open ${archive.volumes[0].name} with a ZIP/7z-compatible app.`
      : `Open ${archive.volumes[0].name} with a ZIP-compatible app.`,
  };
}
