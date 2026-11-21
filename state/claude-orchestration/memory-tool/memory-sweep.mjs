import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { collectReport } from './report-data.mjs';
import { snapshot, directory, sameProcess, summarize, totals, writeJson, powershell, scrub, safetyFiles } from './process-data.mjs';
import { threadStates } from './thread-data.mjs';
import { selectCandidates, sampleMilliseconds, quietCpuSeconds } from './sweep-policy.mjs';

const args = process.argv.slice(2);
if (args.some(arg => !['--apply', '--dry-run'].includes(arg)) || (args.includes('--apply') && args.includes('--dry-run'))) {
  throw new Error('Usage: node memory-sweep.mjs [--dry-run | --apply]');
}
const apply = args.includes('--apply');
try {
  const { report, raw } = await collectReport();
  const reportFile = await writeJson('memory-report', report);
  await delay(sampleMilliseconds);
  const after = await snapshot();
  const candidates = selectCandidates(report, raw, after);
  const visible = candidates.map(p => ({ ...p, commandLine: scrub(p.commandLine).slice(0, 300) }));
  const summary = { mode: apply ? 'apply' : 'dry-run', capturedAt: new Date().toISOString(), reportFile,
    cpuSample: { minimumMilliseconds: sampleMilliseconds, maximumIncreaseSeconds: quietCpuSeconds,
      before: raw.capturedAt, after: after.capturedAt },
    totals: totals(candidates), byThread: summarize(candidates), candidates: visible,
    excludedUnknownThreadCount: report.processes.filter(p => !p.threadId).length,
    errors: report.threads.errors, safety: report.safety, outcomes: [] };
  // This durable list precedes every termination. Dry-run never invokes the stopper.
  const file = await writeJson('memory-sweep', summary);
  console.table(visible.map(p => ({ pid: p.pid, name: p.name, thread: p.threadId,
    privateMiB: Math.round(p.privateBytes / 1048576), reason: p.reason })));
  if (apply) {
    const failedGroups = new Set(), drainedRoots = new Set();
    const journal = `${file}.outcomes.jsonl`;
    for (const target of candidates) {
      if (failedGroups.has(target.groupRootPid)) continue;
      try {
        const fresh = await collectReport({ devices: false });
        await delay(sampleMilliseconds);
        const current = await snapshot();
        const states = await threadStates([target.threadId]);
        fresh.report.safety = await safetyFiles();
        for (const p of fresh.report.processes) {
          if (p.threadId === target.threadId) p.thread = states.states[target.threadId] ?? null;
        }
        const eligible = selectCandidates(fresh.report, fresh.raw, current, Date.now(), drainedRoots)
          .find(p => p.pid === target.pid && p.reason === target.reason && p.threadId === target.threadId && sameProcess(p, target));
        if (!eligible) throw new Error('No longer eligible; skipped');
        const targetFile = path.join(directory, 'reports', `target-${target.pid}-${Date.now()}.json`);
        await fs.writeFile(targetFile, JSON.stringify({ pid: target.pid, name: target.name,
          executablePath: target.executablePath, startedAt: target.startedAt, cpuSeconds: eligible.cpuSeconds }), { flag: 'wx' });
        await fs.appendFile(journal, JSON.stringify({ at: new Date().toISOString(), pid: target.pid, state: 'dispatching' }) + '\n');
        await powershell(['-File', path.join(directory, 'stop-process.ps1'), '-TargetFile', targetFile]);
        const verification = await snapshot();
        if (verification.processes.some(p => sameProcess(p, target))) throw new Error('Target remains after termination');
        drainedRoots.add(target.groupRootPid);
        await fs.appendFile(journal, JSON.stringify({ at: new Date().toISOString(), pid: target.pid, state: 'confirmed-exited' }) + '\n');
      } catch (error) {
        failedGroups.add(target.groupRootPid);
        await fs.appendFile(journal, JSON.stringify({ at: new Date().toISOString(), pid: target.pid,
          state: 'failed-or-skipped-no-retry', error: scrub(error.message) }) + '\n');
      }
    }
  }
  console.log(JSON.stringify({ file, reportFile, mode: summary.mode, totals: summary.totals,
    byThread: summary.byThread, excludedUnknownThreadCount: summary.excludedUnknownThreadCount,
    errors: summary.errors, wudf: report.wudf }, null, 2));
} catch (error) { console.error(scrub(error.message)); process.exitCode = 1; }
