import fs from 'node:fs';
import path from 'node:path';

const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
export function checkRequest(request, config, session) {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuid.test(request.operationId) || !uuid.test(request.threadId)) throw new Error('Exact operation/thread UUIDs are required.');
  if (!request.purpose || !request.scriptSha256?.match(/^[0-9a-f]{64}$/i)) throw new Error('Purpose and exact script hash are required.');
  if (!Array.isArray(request.arguments) || request.arguments.some(x => typeof x !== 'string' || /[\r\n\x00]/.test(x))) throw new Error('Arguments must be strings without control separators.');
  if (session.sandbox?.type !== 'dangerFullAccess') throw new Error('This task does not permit unrestricted local execution; admin transport must not bypass its sandbox.');
  if (session.approvalPolicy !== 'never') throw new Error('This transport cannot satisfy this task\'s separate approval policy; do not bypass it.');
  if (session.thread?.id !== request.threadId || session.thread?.status?.type !== 'active') throw new Error('Owning task is not active.');
  if (path.resolve(session.cwd).toLowerCase() !== path.resolve(request.workspace).toLowerCase()) throw new Error('Workspace does not match the exact owning task.');
  const script = path.resolve(request.scriptPath).toLowerCase();
  const workspace = path.resolve(request.workspace).toLowerCase();
  const utility = path.resolve(config.controlRoot).toLowerCase();
  if (!script.startsWith(workspace + path.sep) && !script.startsWith(utility + path.sep)) throw new Error('Script is outside the task or explicitly configured control utility.');
  if (path.extname(script) !== '.ps1') throw new Error('Only a pinned local PowerShell script is accepted, not raw shell input.');
  return { threadId: request.threadId, workspace: session.cwd, model: session.model, sandbox: session.sandbox.type, approvalPolicy: session.approvalPolicy };
}

// The existing Windows PowerShell host can decode redirected output using the
// Windows code page. An ASCII JSON envelope preserves exact Unicode values
// without changing the admission checks or requiring a host restart.
export function guardResultJson(result) {
  return JSON.stringify(result).replace(/[\u0080-\uffff]/g, (character) =>
    '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0'));
}

async function main() {
  const { AppServerClient } = await import('./app-server-client.mjs');
  const request = read(process.argv[2]); const config = read(process.argv[3]);
  const canonical = read(path.join(config.controlRoot, 'launcher/state/current.json'));
  const endpoint = new URL(canonical.websocketUrl);
  if (endpoint.protocol !== 'ws:' || !['127.0.0.1','localhost','[::1]'].includes(endpoint.hostname) || !canonical.desktopConnectionVerified) throw new Error('Canonical local shared AppServer is unavailable.');
  const client = new AppServerClient(endpoint.href);
  await client.connect();
  try {
    const own = (await client.call('thread/read', { threadId: request.threadId, includeTurns: false })).thread;
    const session = await client.call('thread/resume', { threadId: request.threadId, excludeTurns: true });
    session.thread = own;
    console.log(guardResultJson(checkRequest(request, config, session)));
  } finally { client.close(); }
}
if (process.argv[1]?.endsWith('guard.mjs')) {
  try { await main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
