import { ancestors, cua, parentOf, sameProcess } from './process-data.mjs';

export const sampleMilliseconds = 10000;
export const quietCpuSeconds = 0.05;
const hour = 3600000;
const forbidden = /^(codex|ChatGPT|WUDFHost|claude|CodexDiscordRemoteHost)\.exe$/i;
function protectedProcess(p, index, safety) {
  if (forbidden.test(p.name) || p.pid <= 4 || !p.executablePath || !p.startedAt || p.sessionId === 0
    || /[\\/](?:Windows|System32)[\\/]/i.test(p.executablePath)) return true;
  const lineage = [p, ...ancestors(p, index)];
  return lineage.some(row => row.pid === safety.autopilotPid || /^claude\.exe$/i.test(row.name)
    || /^CodexDiscordRemoteHost\.exe$/i.test(row.name)
    || /(?:^|[\\/\s])(?:autopilot\.mjs|tsc(?:\.js)?)(?:["'\s]|$)/i.test(row.commandLine || ''));
}
export function selectCandidates(report, before, after, now = Date.now(), drainedRoots = new Set()) {
  const safety = report.safety;
  const index = new Map(after.processes.map(p => [p.pid, p]));
  const prior = new Map(before.processes.map(p => [p.pid, p]));
  const elapsed = Date.parse(after.capturedAt) - Date.parse(before.capturedAt);
  const metadata = new Map(report.processes.map(p => [p.pid, p]));
  const decisions = [];
  const quiet = p => {
    const old = prior.get(p.pid);
    return elapsed >= sampleMilliseconds && sameProcess(old, p)
      && Number.isFinite(old.cpuSeconds) && Number.isFinite(p.cpuSeconds)
      && p.cpuSeconds >= old.cpuSeconds && p.cpuSeconds - old.cpuSeconds <= quietCpuSeconds;
  };
  const replRoots = new Map();
  for (const p of after.processes.filter(p => /^node_repl\.exe$/i.test(p.name))) {
    const m = metadata.get(p.pid), thread = m?.thread;
    const end = Date.parse(thread?.lastTurnEndedAt);
    const children = after.processes.filter(child => ancestors(child, index).some(a => a.pid === p.pid));
    if (safety.planError || safety.lockError || !Array.isArray(safety.plan)) continue;
    if (!m?.threadId || thread?.status !== 'idle' || !['none', 'complete'].includes(thread.goalStatus)
      || !['completed', 'failed', 'interrupted'].includes(thread.latestTurnStatus)
      || !Number.isFinite(end) || now - end < 12 * hour || safety.plan.includes(m.threadId)) continue;
    if (!children.some(cua) && !drainedRoots.has(p.pid)) continue;
    // A live descendant outside the authorized node/git tree makes the whole group ineligible.
    const group = [p, ...children];
    if (group.some(child => !/^(node|cua_node|node_repl|git)\.exe$/i.test(child.name)
      || metadata.get(child.pid)?.ownershipStatus === 'conflicting'
      || (metadata.get(child.pid)?.threadId && metadata.get(child.pid).threadId !== m.threadId)
      || protectedProcess(child, index, safety) || !quiet(child))) continue;
    replRoots.set(p.pid, { root: p, members: group, threadId: m.threadId });
  }
  const grouped = new Set();
  for (const { root, members, threadId } of replRoots.values()) {
    for (const p of members) {
      if (grouped.has(p.pid)) continue;
      grouped.add(p.pid);
      decisions.push({ ...p, threadId, reason: 'idle-thread-12h', groupRootPid: root.pid,
        depth: ancestors(p, index).findIndex(a => a.pid === root.pid) + 1 });
    }
  }
  for (const p of after.processes) {
    if (grouped.has(p.pid) || !/^(node|git)\.exe$/i.test(p.name)) continue;
    // Unknown ownership of a managed cua process never falls through to orphan cleanup.
    if (cua(p) || protectedProcess(p, index, safety) || safety.lockError) continue;
    if (parentOf(p, index) || now - Date.parse(p.startedAt) < hour || !quiet(p)) continue;
    const m = metadata.get(p.pid);
    // A known live/unfinished thread remains protected even if its original parent exited.
    if (!m?.threadId || !m.thread || m.thread.status !== 'idle' || !['none', 'complete'].includes(m.thread.goalStatus)) continue;
    if (safety.planError || safety.plan?.includes(m.threadId)) continue;
    // A detached parent alone proves orphan status, not the executable's identity.
    if (!p.commandLine || /[\\/](?:Windows|System32)[\\/]/i.test(p.executablePath)) continue;
    const descendants = after.processes.filter(child => ancestors(child, index).some(a => a.pid === p.pid));
    if (descendants.length) continue;
    decisions.push({ ...p, threadId: m?.threadId ?? null, reason: 'orphan-1h-quiet', groupRootPid: p.pid, depth: 0 });
  }
  return decisions.sort((a, b) => b.depth - a.depth || b.privateBytes - a.privateBytes);
}
