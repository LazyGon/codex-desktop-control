import fs from 'node:fs';
import path from 'node:path';
import { createExclusiveBackup, atomicWriteJson } from './sync-desktop-projects.mjs';
import { readDesktopState, readProjectRecoveryBackup, recoverDesktopProjects } from './desktop-state-recovery.mjs';

const options = {};
for (let index = 2; index < process.argv.length; index += 1) {
  const key = process.argv[index];
  if (['--dry-run', '--validate-backup'].includes(key)) options[key] = true;
  else if (['--global-state', '--backup', '--backup-directory'].includes(key) && process.argv[index + 1]) {
    options[key] = process.argv[++index];
  } else throw new Error(`Invalid option: ${key}`);
}
const backup = readProjectRecoveryBackup(options['--backup']);
if (options['--validate-backup']) {
  console.log(JSON.stringify({ ok: true, projects: Object.keys(backup['local-projects']).length }));
} else {
  const globalStatePath = path.resolve(options['--global-state']);
  const directory = path.resolve(options['--backup-directory']);
  const loaded = readDesktopState(globalStatePath, directory);
  const restored = recoverDesktopProjects(loaded.state, backup);
  const changed = loaded.recoveredFrom !== null || JSON.stringify(loaded.state) !== JSON.stringify(restored);
  let preservedOriginal = null;
  if (changed && !options['--dry-run']) {
    if (fs.readFileSync(globalStatePath, 'utf8') !== loaded.originalText) {
      throw new Error('Desktop state changed during repair. No state was overwritten.');
    }
    preservedOriginal = createExclusiveBackup(globalStatePath, directory);
    atomicWriteJson(globalStatePath, restored);
    JSON.parse(fs.readFileSync(globalStatePath, 'utf8'));
  }
  console.log(JSON.stringify({ ok: true, dryRun: Boolean(options['--dry-run']), changed,
    projects: Object.keys(restored['local-projects']).length,
    assignments: Object.keys(restored['thread-project-assignments']).length,
    recoverySource: path.resolve(options['--backup']), preservedOriginal }));
}
