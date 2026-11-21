import { validateSharedRuntime } from '../../../control/codex-shared.mjs';
import { connectCanonical } from '../../../control/shared-task-operations.mjs';
import { ancestors, scrub } from './process-data.mjs';

const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
export function ownership(p, rows) {
  const lineage = [p, ...ancestors(p, new Map(rows.map(row => [row.pid, row])))];
  const repl = lineage.find(row => /^node_repl\.exe$/i.test(row.name));
  const codex = lineage.find(row => /^codex\.exe$/i.test(row.name));
  const evidence = [];
  const shared = codex && /\bapp-server\b/.test(codex.commandLine || '');
  for (const row of lineage) {
    if (row.environmentThreadId && !(shared && row.environmentThreadId === codex.environmentThreadId)) {
      evidence.push({ threadId: row.environmentThreadId, source: `environment:${row.pid}` });
    }
    // Arbitrary UUIDs and temporal proximity do not establish process ownership.
    const re = new RegExp(`(?:--thread-id|--session-id|\\bresume)\\s+["']?(${uuid})`, 'ig');
    for (const match of (row.commandLine || '').matchAll(re)) evidence.push({ threadId: match[1].toLowerCase(), source: `argument:${row.pid}` });
    if (row === codex) break;
  }
  const ids = [...new Set(evidence.map(item => item.threadId))];
  return { threadId: ids.length === 1 ? ids[0] : null, ownershipEvidence: evidence,
    ownershipStatus: ids.length === 1 ? 'identified' : ids.length ? 'conflicting' : 'unknown',
    replPid: repl?.pid ?? null, codexPid: codex?.pid ?? null };
}
function timestamp(value) {
  if (typeof value === 'number') return new Date(value < 1e12 ? value * 1000 : value).toISOString();
  return value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
}
export async function threadStates(ids) {
  const states = {}, errors = [];
  let client;
  try {
    const runtime = await validateSharedRuntime({ timeoutMilliseconds: 15000 });
    client = await connectCanonical({ requestTimeoutMs: 60000 });
    // Membership is advisory for a report; direct reads resolve identified owners.
    // Avoid loading the machine's entire historical inventory during memory pressure.
    const page = await client.call('thread/list', { archived: false, limit: 10 });
    const listed = page.data || [];
    const known = new Map(listed.map(thread => [thread.id, thread]));
    for (const id of ids) {
      try {
        const thread = (await client.call('thread/read', { threadId: id, includeTurns: false })).thread;
        if (thread.id !== id) throw new Error('Thread identity mismatch');
        const page = await client.call('thread/turns/list', { threadId: id, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded' });
        const turn = page.data?.[0];
        let goalStatus = 'unknown', goalError = null;
        try {
          const response = await client.call('thread/goal/get', { threadId: id });
          if (Object.hasOwn(response, 'goal')) goalStatus = response.goal === null ? 'none' : response.goal?.status || 'unknown';
        } catch (error) { goalError = scrub(error.message).slice(0, 200); }
        states[id] = { id, status: thread.status?.type || 'unknown', listed: known.has(id),
          cwd: thread.cwd, latestTurnId: turn?.id ?? null, latestTurnStatus: turn?.status ?? null,
          lastTurnEndedAt: timestamp(turn?.completedAt ?? turn?.endedAt), goalStatus, goalError };
      } catch (error) { states[id] = { id, status: 'unknown', goalStatus: 'unknown', error: scrub(error.message).slice(0, 200) }; }
    }
    return { states, errors, canonicalServerPid: runtime.serverProcessId, listedSampleCount: listed.length };
  } catch (error) {
    errors.push(scrub(error.message).slice(0, 300));
    return { states, errors };
  } finally { client?.close(); }
}
