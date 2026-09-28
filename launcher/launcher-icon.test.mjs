import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const helper = path.join(import.meta.dirname, 'CodexLauncherIcon.ps1');
const quote = value => `'${value.replaceAll("'", "''")}'`;
const pathShell = (process.env.PATH ?? '').split(path.delimiter)
  .map(directory => path.join(directory.replace(/^"|"$/g, ''), 'pwsh.exe'))
  .find(candidate => fs.existsSync(candidate));
const shells = process.platform === 'win32' ? [...new Set([
  path.join(process.env.WINDIR ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe'),
  path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'PowerShell', '7-preview', 'pwsh.exe'),
  pathShell,
].filter(value => value && fs.existsSync(value)))] : [];

// Valid transparent 32-bit DIB frames, including their ICO AND masks.
function makeIcon(sizes) {
  const directory = Buffer.alloc(6 + sizes.length * 16);
  directory.writeUInt16LE(1, 2);
  directory.writeUInt16LE(sizes.length, 4);
  let offset = directory.length;
  const frames = sizes.map((size, index) => {
    const pixels = size * size * 4;
    const mask = Math.ceil(size / 32) * 4 * size;
    const frame = Buffer.alloc(40 + pixels + mask);
    frame.writeUInt32LE(40, 0);
    frame.writeInt32LE(size, 4);
    frame.writeInt32LE(size * 2, 8);
    frame.writeUInt16LE(1, 12);
    frame.writeUInt16LE(32, 14);
    frame.writeUInt32LE(pixels, 20);
    const entry = 6 + index * 16;
    directory[entry] = size === 256 ? 0 : size;
    directory[entry + 1] = size === 256 ? 0 : size;
    directory.writeUInt16LE(1, entry + 4);
    directory.writeUInt16LE(32, entry + 6);
    directory.writeUInt32LE(frame.length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    offset += frame.length;
    return frame;
  });
  return Buffer.concat([directory, ...frames]);
}

for (const shell of shells) {
  const run = command => execFileSync(shell, [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    `$ErrorActionPreference = 'Stop'; Set-StrictMode -Version Latest; . ${quote(helper)}; ${command}`,
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }).trim();
  const fixture = context => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-launcher-icon-'));
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const resources = path.join(root, 'app', 'resources');
    fs.mkdirSync(resources, { recursive: true });
    const launcher = path.join(root, 'launcher');
    fs.mkdirSync(launcher);
    return { root, resources, launcher };
  };
  const install = ({ root, launcher }) => JSON.parse(run(
    `Install-CodexLauncherIcon -InstallLocation ${quote(root)} -LauncherRoot ${quote(launcher)} | ConvertTo-Json -Compress`,
  ));

  test(`${path.basename(shell)}: preserves every icon frame and uses a content-specific cache path`, context => {
    const fixture_ = fixture(context);
    const source = makeIcon([16, 32, 48, 64, 256]);
    fs.writeFileSync(path.join(fixture_.resources, 'icon-chatgpt.ico'), source);
    const first = install(fixture_);
    assert.deepEqual(first.FrameSizes, ['16x16', '32x32', '48x48', '64x64', '256x256']);
    assert.deepEqual(fs.readFileSync(first.IconPath), source);
    assert.deepEqual(fs.readFileSync(first.ShortcutIconPath), source);
    assert.equal(install(fixture_).ShortcutIconPath, first.ShortcutIconPath);
    const changed = makeIcon([32, 48, 256]);
    fs.writeFileSync(path.join(fixture_.resources, 'icon-chatgpt.ico'), changed);
    const second = install(fixture_);
    assert.notEqual(second.ShortcutIconPath, first.ShortcutIconPath);
    assert.deepEqual(fs.readFileSync(first.ShortcutIconPath), source);
    assert.deepEqual(fs.readFileSync(second.IconPath), changed);
  });

  test(`${path.basename(shell)}: falls back to a full packaged app icon, not a small extracted frame`, context => {
    const fixture_ = fixture(context);
    fs.writeFileSync(path.join(fixture_.resources, 'icon-chatgpt.ico'), makeIcon([32]));
    const fallback = makeIcon([32, 48, 256]);
    const fallbackPath = path.join(fixture_.resources, 'chatgpt-app-light.ico');
    fs.writeFileSync(fallbackPath, fallback);
    const result = install(fixture_);
    assert.equal(result.SourcePath, fallbackPath);
    assert.deepEqual(fs.readFileSync(result.IconPath), fallback);
  });

  test(`${path.basename(shell)}: refuses low-resolution-only icons without overwriting the installed icon`, context => {
    const fixture_ = fixture(context);
    fs.writeFileSync(path.join(fixture_.resources, 'icon-chatgpt.ico'), makeIcon([32]));
    const previous = Buffer.from('previous icon');
    const installedPath = path.join(fixture_.launcher, 'CodexSharedLauncher.ico');
    fs.writeFileSync(installedPath, previous);
    assert.throws(() => install(fixture_), /No packaged multi-resolution/);
    assert.deepEqual(fs.readFileSync(installedPath), previous);
  });

  test(`${path.basename(shell)}: rejects invalid ICO headers, directories and out-of-bounds frames`, context => {
    const fixture_ = fixture(context);
    const sourcePath = path.join(fixture_.resources, 'icon-chatgpt.ico');
    for (const bytes of [Buffer.from('not an ico'), makeIcon([32, 256]).subarray(0, 20), makeIcon([32, 256]).subarray(0, 100)]) {
      fs.writeFileSync(sourcePath, bytes);
      assert.throws(() => install(fixture_), /Invalid ICO/);
    }
  });
}
