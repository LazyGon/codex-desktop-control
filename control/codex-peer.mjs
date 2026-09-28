import fs from 'node:fs';
import process from 'node:process';
import { randomUUID } from 'node:crypto';
import { loadConfig, requireBotToken } from '../discord-bridge/src/config.mjs';
import { TaskListFederation } from '../discord-bridge/src/task-list-federation.mjs';

const usage = `codex-peer --pc PC_ID <command> [task-id] [options]
  list [--search TEXT]
  status | projects
  read <task-id>
  create --project PROJECT_ID --message TEXT
  send|steer|deliver <task-id> --message TEXT
  interrupt|archive <task-id>

Options: --message-file PATH, --user-id DISCORD_USER_ID,
         --operation-id UUID (reuse only to check an uncertain effect).`;

function parseArguments(values) {
  const options = {};
  const positionals = [];
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith('--')) { positionals.push(value); continue; }
    const name = value.slice(2);
    if (!['pc', 'search', 'project', 'message', 'message-file', 'user-id', 'operation-id'].includes(name)
      || options[name] !== undefined || !values[index + 1] || values[index + 1].startsWith('--')) {
      throw new Error(`Invalid option: ${value}`);
    }
    options[name] = values[++index];
  }
  return { options, positionals };
}

function promptFrom(options) {
  if (options.message && options['message-file']) throw new Error('Choose one message source.');
  return options['message-file'] ? fs.readFileSync(options['message-file'], 'utf8') : options.message;
}

function operationFrom(command, threadId, options) {
  if (command === 'status' || command === 'projects') return { action: command };
  if (command === 'read' || command === 'catchup') return { action: 'read', threadId };
  if (command === 'create') return { action: 'create', projectId: options.project, prompt: promptFrom(options) };
  if (['send', 'steer', 'deliver'].includes(command)) {
    return { action: command, threadId, prompt: promptFrom(options) };
  }
  if (['interrupt', 'archive'].includes(command)) return { action: command, threadId };
  throw new Error(`Unknown command: ${command}`);
}

async function main() {
  if (process.argv.slice(2).some((value) => ['-h', '--help', 'help'].includes(value))) {
    process.stdout.write(`${usage}\n`); return;
  }
  const { options, positionals } = parseArguments(process.argv.slice(2));
  if (!options.pc || positionals.length === 0 || positionals.length > 2) throw new Error(usage);
  const config = loadConfig();
  if (!config.multiPcEnabled) throw new Error('Multi-PC mode is not enabled.');
  const userId = options['user-id'] ?? (config.authorizedUserIds.length === 1 ? config.authorizedUserIds[0] : null);
  if (!userId || !config.authorizedUserIds.includes(userId)) {
    throw new Error('Specify one configured operator with --user-id.');
  }
  const federation = new TaskListFederation({ config, token: requireBotToken(), getLocalTasks: async () => [] });
  try {
    const command = positionals[0];
    if (command === 'list') {
      if (positionals.length !== 1) throw new Error('list does not take a task ID.');
      const result = await federation.listPeer({ instanceId: options.pc, userId, search: options.search ?? null });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }
    const operation = operationFrom(command, positionals[1], options);
    const operationId = options['operation-id'] ?? randomUUID();
    let result;
    try {
      result = await federation.operatePeer({ instanceId: options.pc, userId, operation, requestId: operationId });
    } catch (error) {
      throw new Error(`${error.message} Operation ID: ${operationId}. Do not retry with a new ID until the peer outcome is checked.`);
    }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.state !== 'completed') process.exitCode = 2;
  } finally { await federation.stop(); }
}

main().catch((error) => {
  process.stderr.write(`codex-peer: ${error.message}\n`);
  process.exitCode = 1;
});
