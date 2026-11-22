import fs from 'node:fs';
import path from 'node:path';
import { retireThread } from './retire-threads.mjs';

const MIN_INTERVAL_MS = 10 * 60_000;
const RETRY_INTERVAL_MS = 15 * 60_000;
const MAX_ATTEMPTS = 3;
const TERMINAL_PHASES = new Set(['completed', 'failed', 'result-unavailable', 'unknown-do-not-resend']);

export function createOperationNotifier({ directory, resultsDirectory, notify, log, retire = retireThread, now = Date.now }) {
  const markers = path.join(directory, '.notified');
  const stateFile = path.join(markers, 'attempts.json');
  fs.mkdirSync(markers, { recursive: true });
  let state = { lastAttemptAt: null, files: {} };
  try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  const save = () => {
    fs.writeFileSync(stateFile + '.tmp', JSON.stringify(state));
    fs.renameSync(stateFile + '.tmp', stateFile);
  };
  let pending;

  async function retireNotified(operationId, request, result) {
    if (request.retire !== true || !result.threadId) return;
    const receipt = path.join(markers, operationId + '.retirement.json');
    if (fs.existsSync(receipt)) return;
    // Claim before awaiting: a crash or uncertain outcome must never dispatch twice.
    fs.writeFileSync(receipt, JSON.stringify({ phase: 'dispatching', threadId: result.threadId }), { flag: 'wx' });
    try {
      const outcome = await retire(result.threadId);
      fs.writeFileSync(receipt, JSON.stringify({ threadId: result.threadId, phase: outcome.phase, reason: outcome.reason }));
      log({ watchOps: 'retirement', operationId, threadId: result.threadId, phase: outcome.phase });
    } catch (error) {
      fs.writeFileSync(receipt, JSON.stringify({ phase: 'unknown-do-not-resend', error: error.message }));
      log({ watchOps: 'retirement-unknown', operationId });
    }
  }

  async function poll() {
    const time = now();
    if (state.lastAttemptAt !== null && time - state.lastAttemptAt < MIN_INTERVAL_MS) return;
    const operations = [];
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const operationId = path.basename(entry.name, '.json');

      const attempt = state.files[operationId];
      const resultFile = path.resolve(resultsDirectory, operationId, 'result.json');
      try {
        const request = JSON.parse(fs.readFileSync(path.join(directory, entry.name), 'utf8'));
        const result = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
        if (fs.existsSync(path.join(markers, operationId))) {
          await retireNotified(operationId, request, result);
          continue;
        }
        if (attempt && (attempt.attempts >= MAX_ATTEMPTS || time - attempt.lastAttemptAt < RETRY_INTERVAL_MS)) continue;
        if (!TERMINAL_PHASES.has(result.phase)) continue;
        const excerpt = { ...result };
        if (typeof excerpt.answer === 'string') excerpt.answer = Array.from(excerpt.answer).slice(0, 1500).join('');
        operations.push({ operationId, request, result, prompt:
          `Codex依頼 ${operationId} が ${result.phase} で終了。note: ${request.note ?? ''}。result.json の内容（answerは先頭1500字まで）を読んで検証・報告し、次の手順に進んでください\n` +
          resultFile + '\n' + JSON.stringify(excerpt, null, 2) });
      } catch (e) {
        if (e.code !== 'ENOENT') log({ watchOps: 'read-failed', operationId, code: e.code ?? e.name });
      }
    }
    if (!operations.length) return;
    const ids = operations.map(item => item.operationId);
    state.lastAttemptAt = time;
    for (const id of ids) {
      state.files[id] = { attempts: (state.files[id]?.attempts ?? 0) + 1, lastAttemptAt: time };
    }
    // Match needs-user: persist the retry budget before invoking Claude.
    save();
    log({ watchOps: 'attempt', operations: ids });
    let result;
    try { result = await notify(operations.map(item => item.prompt).join('\n\n')); }
    catch { result = { code: -1, isError: true }; }
    if (result?.code === 0 && result.isError === false) {
      for (const id of ids) fs.writeFileSync(path.join(markers, id), new Date(now()).toISOString() + '\n');
      log({ watchOps: 'notified', operations: ids });
      for (const item of operations) await retireNotified(item.operationId, item.request, item.result);
    } else {
      log({ watchOps: 'failed', operations: ids, code: result?.code ?? null, isError: result?.isError ?? null,
        exhausted: ids.filter(id => state.files[id].attempts >= MAX_ATTEMPTS) });
    }
  }

  return () => {
    pending ??= poll().finally(() => { pending = null; });
    return pending;
  };
}
