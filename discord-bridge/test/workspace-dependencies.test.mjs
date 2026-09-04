import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadWorkspaceDependencies } from '../src/workspace-dependencies.mjs';

function createRuntime(root) {
  fs.writeFileSync(path.join(root, 'runtime.json'), JSON.stringify({
    bundleVersion: '26.903.11726',
    targetPlatform: 'win32',
  }));
  for (const relativePath of [
    ['native', 'git', 'cmd', 'git.exe'],
    ['node', 'bin', 'node.exe'],
    ['bin', 'fallback', 'pnpm.cmd'],
    ['python', 'python.exe'],
  ]) {
    const filePath = path.join(root, 'dependencies', ...relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, 'fixture');
  }
  for (const relativePath of [
    ['node', 'node_modules'],
    ['bin', 'override'],
  ]) {
    fs.mkdirSync(path.join(root, 'dependencies', ...relativePath), { recursive: true });
  }
}

test('workspace dependencies mirror the installed Desktop runtime contract', (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-workspace-runtime-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  createRuntime(root);

  const result = loadWorkspaceDependencies({ runtimeRoot: root });

  assert.match(result, /Workspace dependencies are available for this local Discord task/);
  assert.match(result, /Bundle version: `26\.903\.11726`/);
  assert.match(result, new RegExp(path.join(root, 'dependencies', 'node', 'bin', 'node.exe')
    .replaceAll('\\', '\\\\')));
  assert.match(result, /Node\.js packages:/);
  assert.match(result, /Python executable:/);
  assert.match(result, /Override binaries:/);
});

test('workspace dependencies fail closed when an advertised component is missing', (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-workspace-runtime-missing-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  createRuntime(root);
  fs.rmSync(path.join(root, 'dependencies', 'python', 'python.exe'));

  assert.throws(
    () => loadWorkspaceDependencies({ runtimeRoot: root }),
    /component is unavailable: Python executable/,
  );
});
