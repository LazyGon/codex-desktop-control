import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('multi-PC config helper preserves existing settings, keeps a backup and refuses a running Bridge', { skip: process.platform !== 'win32' }, (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'multi-pc-config-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.mkdirSync(path.join(directory, 'config'));
  fs.mkdirSync(path.join(directory, 'data'));
  const script = path.join(directory, 'Enable-MultiPcBridge.ps1');
  fs.copyFileSync(path.resolve(import.meta.dirname, '../Enable-MultiPcBridge.ps1'), script);
  const configPath = path.join(directory, 'config/config.json');
  const initial = { applicationId: 'app', guildId: 'guild', authorizedUserIds: ['user'],
    plainMessageInputEnabled: true, custom: { preserved: true } };
  fs.writeFileSync(configPath, JSON.stringify(initial));
  const powershell = path.join(process.env.WINDIR, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const args = ['-NoProfile', '-NonInteractive', '-File', script, '-InstanceId', 'A', '-ListenHost', '100.75.107.79',
    '-PeerInstanceId', 'B', '-PeerHost', '100.104.140.74'];
  execFileSync(powershell, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const updated = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(updated.multiPcEnabled, true);
  assert.equal(updated.applicationId, initial.applicationId);
  assert.deepEqual(updated.authorizedUserIds, initial.authorizedUserIds);
  assert.deepEqual(updated.custom, initial.custom);
  assert.equal(updated.plainMessageInputEnabled, true);
  assert.equal(updated.taskControlEnabled, false);
  assert.equal(updated.taskListPeers[0].allowTaskControl, false);
  const backup = fs.readdirSync(path.join(directory, 'config')).find((file) => file.endsWith('.bak'));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, 'config', backup), 'utf8')), initial);
  execFileSync(powershell, [...args, '-EnableTaskControl'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const controlEnabled = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(controlEnabled.taskControlEnabled, true);
  assert.equal(controlEnabled.taskControlTimeoutMs, 60000);
  assert.equal(controlEnabled.taskListPeers[0].allowTaskControl, true);
  execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-File', script,
    '-InstanceId', 'A', '-ListenHost', '100.75.107.79',
    '-PeerInstanceId', 'C', '-PeerHost', '100.104.140.75'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const changedPeer = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(changedPeer.taskControlEnabled, false);
  assert.equal(changedPeer.taskListPeers[0].allowTaskControl, false);
  execFileSync(powershell, [...args, '-EnableTaskControl'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const before = fs.readFileSync(configPath, 'utf8');
  fs.writeFileSync(path.join(directory, 'data/bridge.lock'), String(process.pid));
  assert.throws(() => execFileSync(powershell, args, { stdio: ['ignore', 'pipe', 'pipe'] }));
  assert.equal(fs.readFileSync(configPath, 'utf8'), before);
});
