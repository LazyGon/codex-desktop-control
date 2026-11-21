import { snapshot, relevant, ancestors, parentOf, scrub, safetyFiles, totals } from './process-data.mjs';
import { ownership, threadStates } from './thread-data.mjs';

export async function collectReport({ devices = true } = {}) {
  const first = await snapshot(devices, true);
  const rows = first.processes;
  const target = rows.filter(relevant);
  const owners = new Map(target.map(p => [p.pid, ownership(p, rows)]));
  const threads = await threadStates([...new Set([...owners.values()].map(o => o.threadId).filter(Boolean))]);
  const safety = await safetyFiles();
  const index = new Map(rows.map(p => [p.pid, p]));
  const processes = target.map(p => {
    const owner = owners.get(p.pid);
    return { ...p, commandLine: scrub(p.commandLine).slice(0, 300), ...owner,
      parentName: parentOf(p, index)?.name ?? 'unknown',
      ancestorPids: ancestors(p, index).map(row => row.pid),
      thread: owner.threadId ? threads.states[owner.threadId] ?? null : null };
  });
  const wudf = target.filter(p => /^WUDFHost\.exe$/i.test(p.name)).map(p => {
    const matches = (first.devices || []).filter(device => device.hostPid === p.pid
      || (device.instanceId && p.commandLine?.toLowerCase().includes(device.instanceId.toLowerCase())));
    return { pid: p.pid, privateBytes: p.privateBytes, workingSetBytes: p.workingSetBytes,
      commandLine: scrub(p.commandLine), devices: matches,
      assessment: matches.length ? `${matches.map(d => `${d.name} (${d.class || d.service || 'unknown'})`).join('; ')}。ホストとの対応は確認済み。高メモリの原因は単一スナップショットでは確定できず、ドライバーの継続観測が必要。`
        : '担当機器はunknown。PnPのホストPID/コマンドラインで対応を確認できず。高メモリの原因は未確定。',
      proposal: '停止・無効化は行わず、対応機器のドライバー更新履歴とメモリ増加を調査する。' };
  });
  return { report: { capturedAt: first.capturedAt, physicalBytes: first.physicalBytes,
    availableBytes: first.availableBytes, memoryMetric: 'privateBytes=Win32_Process.PrivatePageCount; workingSetBytes=WorkingSetSize (shared pages may overlap)',
    totals: totals(processes), processes, threads, safety, wudf,
    deviceError: first.deviceError, pnpDevices: first.devices || [] }, raw: first };
}
export function printTop(report) {
  console.table([...report.processes].sort((a, b) => b.privateBytes - a.privateBytes).slice(0, 30).map(p => ({
    PID: p.pid, PPID: p.parentPid, parent: p.parentName, name: p.name,
    privateMiB: Math.round(p.privateBytes / 1048576), workingMiB: Math.round(p.workingSetBytes / 1048576),
    started: p.startedAt, thread: p.threadId?.slice(0, 8) || 'unknown',
    state: p.thread?.status || 'unknown', goal: p.thread?.goalStatus || 'unknown',
    command: p.commandLine?.slice(0, 95),
  })));
}
