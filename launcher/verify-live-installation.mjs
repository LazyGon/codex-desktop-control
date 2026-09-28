import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { AppServerClient } from '../discord-bridge/src/app-server-client.mjs';
import { loadConfig, dataDir } from '../discord-bridge/src/config.mjs';
import { TaskListFederation } from '../discord-bridge/src/task-list-federation.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const threadId = process.argv[2];
if (!/^[0-9a-f-]{36}$/.test(threadId ?? '')) throw new Error('An explicit task ID is required.');
const client = new AppServerClient('ws://127.0.0.1:8798');
let federation;
let native;
const result = { checkedAt: new Date().toISOString(), threadId };

async function probeNativeTools() {
  native = spawn(process.execPath, [path.join(root, 'codex-app-tools-bridge.mjs')], {
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  // No raw tool descriptions, response payloads or stderr are logged.
  native.stderr.resume();
  const pending = new Map();
  const lines = readline.createInterface({ input: native.stdout });
  lines.on('line', line => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    const operation = pending.get(message.id);
    if (!operation) return;
    pending.delete(message.id);
    clearTimeout(operation.timer);
    if (message.error) operation.reject(new Error(`Native MCP ${operation.method} failed (${message.error.code}): ${String(message.error.message ?? '').slice(0, 240)}`));
    else operation.resolve(message.result);
  });
  let id = 0;
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const current = ++id;
    const timer = setTimeout(() => { pending.delete(current); reject(new Error('Native MCP timed out.')); }, 30000);
    pending.set(current, { resolve, reject, timer, method });
    native.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: current, method, params })}\n`);
  });
  try {
    await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'shared-installation-readonly-probe', version: '1.0.0' } });
    native.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    const catalog = await rpc('tools/list', {});
    result.nativeAppToolsVerified = true;
    result.nativeAppToolCount = catalog.tools?.length ?? 0;
    result.nativeAppUpdateToolAvailable = Boolean(catalog.tools?.some(tool => tool.name === 'check_app_update'));
    // Tools require genuine executor-supplied thread metadata. A standalone
    // protocol probe must not synthesize it or impersonate an executor.
  } finally {
    for (const operation of pending.values()) clearTimeout(operation.timer);
    lines.close();
    native.stdin.end();
    await new Promise(resolve => {
      if (native.exitCode !== null) return resolve();
      const timer = setTimeout(() => { native.kill(); resolve(); }, 3000);
      native.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  }
}

try {
  await client.connect();
  const task = (await client.call('thread/read', { threadId, includeTurns: false })).thread;
  result.localTaskReadVerified = task?.id === threadId;
  const config = loadConfig();
  const state = JSON.parse(await fs.readFile(path.join(dataDir, 'state.json'), 'utf8'));
  const getLocalTasks = async search => {
    const threads = [];
    let cursor = null;
    const seen = new Set();
    do {
      const page = await client.call('thread/list', { limit: 100, archived: false, ...(cursor ? { cursor } : {}), ...(search ? { searchTerm: search } : {}) });
      threads.push(...(page.data ?? []));
      cursor = page.nextCursor;
      if (cursor && seen.has(cursor)) throw new Error('Inventory cursor repeated.');
      seen.add(cursor);
    } while (cursor);
    return threads.filter(thread => !thread.ephemeral && !thread.parentThreadId && !thread.source?.subAgent
      && !state.bindings?.[thread.id]?.hidden)
      .map(thread => ({ ...thread, name: state.bindings?.[thread.id]?.taskName ?? thread.name ?? thread.preview?.split('\n')[0] ?? '(untitled)' }));
  };
  if (!process.env.DISCORD_BOT_TOKEN) throw new Error('A protected Bot token must be supplied in the process environment, never on the command line.');
  federation = new TaskListFederation({ config, token: process.env.DISCORD_BOT_TOKEN, getLocalTasks });
  delete process.env.DISCORD_BOT_TOKEN;
  const started = Date.now();
  const inventory = await federation.collect({ requestId: randomUUID(), userId: config.authorizedUserIds[0] });
  result.inventory = { taskCount: inventory.threads.length, sources: inventory.sources, elapsedMs: Date.now() - started };
  const origin = `http://${config.taskListListenHost}:${config.taskListListenPort}`;
  result.unsignedInventoryHttpStatus = (await fetch(`${origin}/v1/tasks/list`, { method: 'POST', body: '{}', signal: AbortSignal.timeout(5000) })).status;
  result.effectfulRouteHttpStatus = (await fetch(`${origin}/v1/turn/start`, { method: 'POST', body: '{}', signal: AbortSignal.timeout(5000) })).status;
  await probeNativeTools();
  // Reload only queues a refresh at a safe boundary; it does not restart AppServer or mutate tasks.
  if (process.argv.includes('--reload-mcp')) {
    await client.call('config/mcpServer/reload', {});
    result.mcpRefreshQueued = true;
  }
  const servers = await client.call('mcpServerStatus/list', { threadId, detail: 'toolsAndAuthOnly', limit: 100 });
  result.codexAppMcp = (servers.data ?? []).filter(server => server.name === 'codex_app').map(server => ({
    name: server.name, toolCount: Object.keys(server.tools ?? {}).length, authStatus: server.authStatus,
  }));
  const temporary = path.join(root, 'state', 'live-installation-verification.json.tmp');
  await fs.writeFile(temporary, `${JSON.stringify(result, null, 2)}\n`);
  await fs.rename(temporary, path.join(root, 'state', 'live-installation-verification.json'));
  await new Promise((resolve, reject) => process.stdout.write(`${JSON.stringify(result)}\n`, error => error ? reject(error) : resolve()));
} finally {
  delete process.env.DISCORD_BOT_TOKEN;
  await federation?.stop();
  client.close();
}
// Aborted connections to an offline peer can retain Windows TCP timers. This
// one-shot CLI has flushed its result and closed all owned clients; do not keep
// the diagnostic process alive for those implementation-level timers.
process.exit(0);
