import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppServerClient } from '../src/app-server-client.mjs';
import { readJsonIfPresent } from '../src/util.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const candidates = [
  path.join(path.dirname(root), 'launcher', 'state', 'current.json'),
];
const runtime = candidates.map((candidate) => ({ candidate, state: readJsonIfPresent(candidate) }))
  .find((entry) => entry.state?.websocketUrl);
const url = process.env.CODEX_APP_SERVER_WS_URL ?? runtime?.state.websocketUrl ?? 'ws://127.0.0.1:8798';
const client = new AppServerClient(url);

try {
  await client.connect();
  const result = await client.call('thread/list', { limit: 3, sortKey: 'recency_at', sortDirection: 'desc' });
  process.stdout.write(`${JSON.stringify({ ok: true, endpoint: url, taskCount: result.data.length, taskIds: result.data.map((task) => task.id) }, null, 2)}\n`);
} finally {
  client.close();
}
