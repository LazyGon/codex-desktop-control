import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(directory).replaceAll('\\', '/');
const home = os.homedir();
for (const [name, host] of [['claude-peer', '.codex'], ['codex-peer', '.claude']]) {
  const destination = path.join(home, host, 'skills', name);
  fs.mkdirSync(destination, { recursive: true });
  const source = fs.readFileSync(path.join(directory, 'skills', name, 'SKILL.md'), 'utf8');
  const rendered = source.replaceAll('@CONTROL_ROOT@', root).replaceAll('@NODE@', process.execPath.replaceAll('\\', '/'));
  const target = path.join(destination, 'SKILL.md');
  if (fs.existsSync(target) && fs.readFileSync(target, 'utf8') !== rendered) {
    fs.copyFileSync(target, target + '.' + Date.now() + '.bak');
  }
  fs.writeFileSync(target, rendered, 'utf8');
  for (const legal of ['LICENSE', 'NOTICE']) fs.copyFileSync(path.join(directory, legal), path.join(destination, legal));
  console.log(JSON.stringify({ installed: name, host, path: target }));
}
