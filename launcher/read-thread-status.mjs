import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { AppServerClient } from '../discord-bridge/src/app-server-client.mjs';

function parseArguments(argv) {
  const options = { endpoint: null, threadId: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (!value) throw new Error(`Missing value for ${argument}.`);
    index += 1;
    if (argument === '--endpoint') options.endpoint = value;
    else if (argument === '--thread') options.threadId = value;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!options.endpoint) throw new Error('Required option is missing: endpoint');
  if (!options.threadId) throw new Error('Required option is missing: thread');
  return options;
}

async function run() {
  const options = parseArguments(process.argv.slice(2));
  const client = new AppServerClient(options.endpoint);
  let result;
  try {
    await client.connect();
    result = await client.call('thread/read', {
      threadId: options.threadId,
      includeTurns: false,
    }, 30_000);
  } finally {
    client.close();
  }
  if (!result?.thread?.id) throw new Error(`Task was not found: ${options.threadId}`);
  process.stdout.write(`${JSON.stringify({
    id: result.thread.id,
    status: result.thread.status?.type ?? 'unknown',
  })}\n`);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  run().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
