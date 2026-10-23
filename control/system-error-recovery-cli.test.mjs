import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

const worker = fileURLToPath(new URL('./system-error-recovery.mjs', import.meta.url));
async function runWorker(mode, config) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'recovery CLI 日本語 '));
  const preload = path.join(directory, 'remaining-handle.mjs');
  fs.writeFileSync(preload, 'setInterval(() => {}, 1000);\n');
  fs.writeFileSync(path.join(directory, 'config.json'), JSON.stringify(config));
  const child = spawn(process.execPath, ['--import', pathToFileURL(preload).href, worker, mode, '--directory', directory],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', reportTimer, stalledAfterReport = false;
  const startupTimer = setTimeout(() => child.kill(), 15000);
  child.stdout.on('data', bytes => {
    stdout += bytes;
    if (!reportTimer && stdout.includes('\n')) {
      clearTimeout(startupTimer);
      reportTimer = setTimeout(() => { stalledAfterReport = true; child.kill(); }, 1000);
    }
  });
  child.stderr.on('data', bytes => { stderr += bytes; });
  try {
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    return { code, stdout, stderr, stalledAfterReport,
      state: fs.existsSync(path.join(directory, 'last-cycle.json'))
        ? JSON.parse(fs.readFileSync(path.join(directory, 'last-cycle.json'), 'utf8')) : null,
      lockExists: fs.existsSync(path.join(directory, 'cycle.lock')) };
  } finally {
    clearTimeout(startupTimer); clearTimeout(reportTimer);
    if (path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir())) throw new Error('Unexpected temporary cleanup path');
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('status prints complete JSON and exits despite an unrelated referenced handle', async () => {
  const config = { schemaVersion: 1, enabled: false, excludedThreadIds: [] };
  const result = await runWorker('status', config);
  assert.equal(result.stalledAfterReport, false, 'the one-shot worker must release the scheduler after reporting');
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).config, config);
});

test('disabled recovery releases its cycle lock and exits after the result is flushed', async () => {
  const result = await runWorker('run', { schemaVersion: 1, enabled: false, excludedThreadIds: [] });
  assert.equal(result.stalledAfterReport, false);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).disabled, true);
  assert.equal(result.lockExists, false);
});

test('configuration failure persists its report and exits nonzero without retaining the scheduler', async () => {
  const result = await runWorker('run', { schemaVersion: 99, enabled: true, excludedThreadIds: [] });
  assert.equal(result.stalledAfterReport, false);
  assert.equal(result.code, 1, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.stage, 'config');
  assert.ok(Number.isFinite(Date.parse(report.failedAt)));
  assert.deepEqual(result.state, report);
  assert.equal(result.lockExists, false);
});
