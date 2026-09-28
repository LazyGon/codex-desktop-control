import { AppServerClient } from '../discord-bridge/src/app-server-client.mjs';
import { CodexService } from '../discord-bridge/src/codex-service.mjs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
const url = process.argv[2];
if (!/^ws:\/\/127\.0\.0\.1:\d+$/.test(url ?? '')) throw new Error('Verification requires an exact loopback URL.');
const client = new AppServerClient(url, {requestTimeoutMs:10_000});
try {
  await client.connect();
  const result = await client.call('thread/list',{limit:1});
  if (!Array.isArray(result.data)) throw new Error('thread/list returned an invalid response.');
  const service = new CodexService({ config: {}, stateStore: {}, discoverEndpoint: () => ({ url }), logDir: os.tmpdir() });
  service.client = client;
  if (result.data[0]?.id && !await service.hasLocalThread(result.data[0].id)) {
    throw new Error('The listed local task could not be verified with read-only thread/read.');
  }
  if (await service.hasLocalThread(randomUUID())) throw new Error('An unknown task was accepted as local.');
  console.log(JSON.stringify({initialized:true,threadListVerified:true,
    localMembershipVerified:Boolean(result.data[0]?.id),unknownTaskIgnored:true,sampleCount:result.data.length}));
} finally { client.close(); }
