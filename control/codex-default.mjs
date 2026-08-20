import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { routeCodexArguments } from './codex-routing.mjs';

const controlDir = path.dirname(fileURLToPath(import.meta.url));
const sharedCliPath = path.join(controlDir, 'codex-shared.mjs');

function defaultManifestPath() {
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) throw new Error('LOCALAPPDATA is not defined.');
  return path.join(localAppData, 'CodexDesktopControl', 'bin', 'redirect.json');
}

function readManifest() {
  const manifestPath = process.env.CODEX_DESKTOP_CONTROL_REDIRECT_MANIFEST
    || defaultManifestPath();
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, ''));
  if (
    manifest.schemaVersion !== 1
    || typeof manifest.originalCodexJavaScript !== 'string'
    || !path.isAbsolute(manifest.originalCodexJavaScript)
    || !fs.existsSync(manifest.originalCodexJavaScript)
  ) {
    throw new Error(`The Codex CLI redirect manifest is invalid: ${manifestPath}`);
  }
  return manifest;
}

function run(executable, arguments_) {
  const result = spawnSync(executable, arguments_, {
    stdio: 'inherit',
    windowsHide: false,
  });
  if (result.error) throw result.error;
  if (result.signal) return 1;
  return result.status ?? 1;
}

async function main() {
  const values = process.argv.slice(2);
  const route = routeCodexArguments(values);

  if (route.mode === 'unsupported') {
    throw new Error(
      `codex ${route.subcommand} cannot use the shared app-server because upstream --remote `
      + 'currently supports only the interactive TUI. Run plain codex and perform the action '
      + 'from the shared task UI, or use codex-original explicitly if an isolated run is intended.',
    );
  }

  if (route.mode === 'shared') {
    process.exitCode = run(process.execPath, [sharedCliPath, ...values]);
    return;
  }

  const manifest = readManifest();
  process.exitCode = run(process.execPath, [manifest.originalCodexJavaScript, ...values]);
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch(error => {
    process.stderr.write(`codex: ${error.message}\n`);
    process.exitCode = 1;
  });
}
