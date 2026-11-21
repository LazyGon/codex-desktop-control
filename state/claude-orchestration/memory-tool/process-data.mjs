import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const directory = path.dirname(fileURLToPath(import.meta.url));
export const root = path.resolve(directory, '../../..');
export const planFile = path.join(root, 'state/rvm-parallel-implementation-20261116/run-1794818913956/CURRENT.json');
export const lockFile = path.join(directory, '../autopilot.lock');
const run = promisify(execFile);
export async function powershell(args) {
  const exe = path.join(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const { stdout } = await run(exe, ['-NoProfile', '-NonInteractive', ...args], {
    windowsHide: true, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
  });
  return JSON.parse(stdout.replace(/^\uFEFF/, ''));
}
export function snapshot(devices = false, ownership = false) {
  return powershell(['-File', path.join(directory, 'windows-process.ps1'), ...(devices ? ['-Devices'] : []), ...(ownership ? ['-Ownership'] : [])]);
}
export function sameProcess(a, b) {
  return Boolean(a && b && a.startedAt && a.pid === b.pid && a.startedAt === b.startedAt
    && a.executablePath && a.executablePath.toLowerCase() === b.executablePath?.toLowerCase());
}
export function parentOf(p, index) {
  const parent = index.get(p.parentPid);
  return parent && Date.parse(parent.startedAt) <= Date.parse(p.startedAt) ? parent : null;
}
export function ancestors(p, index) {
  const result = [], seen = new Set([p.pid]);
  while ((p = parentOf(p, index)) && !seen.has(p.pid)) { seen.add(p.pid); result.push(p); }
  return result;
}
export function relevant(p) {
  return /^(node|cua_node|node_repl|git|WUDFHost)\.exe$/i.test(p.name) || /[\\/]cua_node[\\/]/i.test(p.executablePath || '');
}
export function cua(p) {
  return /^(node|cua_node)\.exe$/i.test(p.name)
    && /[\\/]OpenAI[\\/]Codex[\\/]runtimes[\\/]cua_node[\\/]/i.test(p.executablePath || '');
}
export function scrub(text) {
  return String(text || '').replace(/((?:token|password|secret|api[-_]?key|authorization)(?:\s*[=:]\s*|\s+))(?:"[^"]*"|'[^']*'|Bearer\s+\S+|\S+)/gi, '$1[REDACTED]')
    .replace(/([?&](?:sig|token|key|secret|password)=)[^&\s"]+/gi, '$1[REDACTED]');
}
export async function safetyFiles() {
  let plan, autopilotPid, planError, lockError;
  try {
    const value = JSON.parse(await fs.readFile(planFile, 'utf8'));
    if (!value.currentAssignmentPlan || !Array.isArray(value.remainingExecutionProgress?.running)) throw new Error('Missing current plan or running array');
    const ids = new Set();
    // Protect every thread referenced by the current assignment plan, including split workers.
    const visit = object => {
      if (!object || typeof object !== 'object') return;
      for (const [key, value] of Object.entries(object)) {
        if (/threadId$/i.test(key) && typeof value === 'string') ids.add(value);
        else if (typeof value === 'object') visit(value);
      }
    };
    visit(value.currentAssignmentPlan); visit(value.remainingExecutionProgress.running);
    plan = [...ids];
  } catch (error) { planError = error.message; }
  try {
    const text = (await fs.readFile(lockFile, 'utf8')).trim();
    const value = /^\d+$/.test(text) ? Number(text) : JSON.parse(text).pid;
    if (!Number.isInteger(value) || value < 1) throw new Error('Invalid autopilot PID');
    autopilotPid = value;
  } catch (error) { lockError = error.message; }
  return { planFile, lockFile, plan, autopilotPid, planError, lockError };
}
export async function writeJson(prefix, value) {
  const output = path.join(directory, 'reports');
  await fs.mkdir(output, { recursive: true });
  const filename = path.join(output, `${prefix}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  await fs.writeFile(filename, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  return filename;
}
export function totals(rows) {
  return { count: rows.length, privateBytes: rows.reduce((sum, p) => sum + (p.privateBytes || 0), 0),
    workingSetBytes: rows.reduce((sum, p) => sum + (p.workingSetBytes || 0), 0) };
}
export function summarize(rows) {
  const groups = new Map();
  for (const p of rows) {
    const key = p.threadId || 'unknown';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }
  return [...groups].map(([threadId, rows]) => ({ threadId, ...totals(rows), pids: rows.map(p => p.pid) }));
}
