import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WINDOWS_COMPONENTS = [
  ['Git executable', ['native', 'git', 'cmd', 'git.exe'], 'file'],
  ['Node.js executable', ['node', 'bin', 'node.exe'], 'file'],
  ['Node.js packages', ['node', 'node_modules'], 'directory'],
  ['pnpm executable', ['bin', 'fallback', 'pnpm.cmd'], 'file'],
  ['Python executable', ['python', 'python.exe'], 'file'],
  ['Python packages', ['python'], 'directory'],
  ['Override binaries', ['bin', 'override'], 'directory'],
  ['Fallback binaries', ['bin', 'fallback'], 'directory'],
];

function defaultRuntimeRoot() {
  return path.join(
    os.homedir(),
    '.cache',
    'codex-runtimes',
    'codex-primary-runtime',
  );
}

function readManifest(manifestPath) {
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    throw new Error('The bundled workspace runtime manifest is unavailable or invalid.');
  }
  if (typeof manifest.bundleVersion !== 'string'
    || !/^[A-Za-z0-9._-]{1,100}$/.test(manifest.bundleVersion)) {
    throw new Error('The bundled workspace runtime has no valid bundle version.');
  }
  if (manifest.targetPlatform !== 'win32') {
    throw new Error('The bundled workspace runtime is not a Windows runtime.');
  }
  return manifest;
}

function requireComponent(dependenciesRoot, label, segments, expectedType) {
  const componentPath = path.join(dependenciesRoot, ...segments);
  let stats;
  try {
    stats = fs.statSync(componentPath);
  } catch {
    throw new Error(`The bundled workspace runtime component is unavailable: ${label}.`);
  }
  const valid = expectedType === 'file' ? stats.isFile() : stats.isDirectory();
  if (!valid) {
    throw new Error(`The bundled workspace runtime component has the wrong type: ${label}.`);
  }
  return componentPath;
}

export function loadWorkspaceDependencies({ runtimeRoot = defaultRuntimeRoot() } = {}) {
  const resolvedRuntimeRoot = path.resolve(runtimeRoot);
  const manifest = readManifest(path.join(resolvedRuntimeRoot, 'runtime.json'));
  const dependenciesRoot = path.join(resolvedRuntimeRoot, 'dependencies');
  const components = WINDOWS_COMPONENTS.map(([label, segments, expectedType]) => [
    label,
    requireComponent(dependenciesRoot, label, segments, expectedType),
  ]);

  return [
    'Workspace dependencies are available for this local Discord task.',
    '',
    '### Workspace Dependencies',
    'Use these bundled paths for sheets, slides, documents, PDFs, images, or browser automation:',
    `- Bundle version: \`${manifest.bundleVersion}\``,
    ...components.map(([label, componentPath]) => `- ${label}: \`${componentPath}\``),
  ].join('\n');
}
