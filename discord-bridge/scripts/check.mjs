import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const files = [];
for (const directory of ['src', 'scripts', 'test']) {
  const full = path.join(root, directory);
  if (!fs.existsSync(full)) continue;
  for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.mjs')) files.push(path.join(full, entry.name));
  }
}

for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    process.stderr.write(`${result.stdout}${result.stderr}`);
    process.exit(result.status ?? 1);
  }
}
process.stdout.write(`Syntax OK: ${files.length} files\n`);
