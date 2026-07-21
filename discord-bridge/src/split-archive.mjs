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
    for (const [index, name] of volumeNames.entries()) {
      const volumePath = path.join(directory, name);
      const stat = await fs.promises.stat(volumePath);
      if (!stat.isFile() || stat.size > volumeBytes) {
        throw new Error(`7-Zip volume is invalid or exceeds the Discord chunk size: ${name}`);
      }
      volumes.push({
        index,
        name,
        path: volumePath,
        size: stat.size,
        sha256: await sha256File(volumePath),
      });
    }
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
