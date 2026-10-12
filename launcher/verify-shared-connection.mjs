import { AppServerClient } from '../discord-bridge/src/app-server-client.mjs';
import { randomUUID } from 'node:crypto';
import { writeSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export async function probeSharedConnection(client, unknownId = randomUUID()) {
  await client.connect();
  const result = await client.call('thread/list',{limit:1});
  if (!Array.isArray(result.data)) throw new Error('thread/list returned an invalid response.');
  const id = result.data[0]?.id;
  if (id) {
    const local = await client.call('thread/read',{threadId:id,includeTurns:false});
    if (local.thread?.id !== id) throw new Error('The listed local task membership did not match.');
  }
  let unknownRejected = false;
  try {
    await client.call('thread/read',{threadId:unknownId,includeTurns:false});
  } catch (error) {
    // Timeout/disconnection is not evidence that an unknown ID was rejected.
    if (!/thread.*(?:not found|not loaded|does not exist)|(?:no|not found).*rollout|invalid.*thread.?id/i.test(error.message)) throw error;
    unknownRejected = true;
  }
  if (!unknownRejected) throw new Error('An unknown task was accepted as local.');
  // "not loaded" proves request rejection, not absence from persisted history.
  return {initialized:true,threadListVerified:true,localMembershipVerified:Boolean(id),unknownTaskIgnored:true,sampleCount:result.data.length};
}

async function main() {
const url = process.argv[2];
if (!/^ws:\/\/127\.0\.0\.1:\d+$/.test(url ?? '')) throw new Error('Verification requires an exact loopback URL.');
// Package activation and metadata migration can saturate a freshly started server.
// This is a bounded startup probe, not the Bridge's fast ownership check.
const client = new AppServerClient(url, {requestTimeoutMs:60_000});
try {
  const result = await probeSharedConnection(client);
  writeSync(1,JSON.stringify(result)+'\n');
} finally { client.close(); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(); process.exit(0); }
  catch (error) { writeSync(2,'Shared connection probe failed: '+error.message+'\n'); process.exit(1); }
  // This read-only CLI has finished all RPCs. Exit only its own process so a
  // socket-close/HTTP-pool handle cannot hold the launch controller indefinitely.
}
