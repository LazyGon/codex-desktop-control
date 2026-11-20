import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

export function claudeExecutable(env = process.env) {
  const candidates = [
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Microsoft/WinGet/Packages/Anthropic.ClaudeCode_Microsoft.Winget.Source_8wekyb3d8bbwe/claude.exe'),
    env.USERPROFILE && path.join(env.USERPROFILE, '.local/bin/claude.exe'),
    ...(env.PATH ?? '').split(path.delimiter).map(p => path.join(p, process.platform === 'win32' ? 'claude.exe' : 'claude')),
  ].filter(Boolean);
  const executable = candidates.find(p => fs.existsSync(p) && fs.statSync(p).isFile());
  if (!executable) throw new Error('Claude Code executable is not installed; no alternative provider was selected.');
  return executable;
}

export function claudeArguments(request) {
  const args = ['-p', '--output-format', 'json'];
  if (request.sessionId) args.push('--resume', request.sessionId);
  if (request.mode === 'review') args.push('--permission-mode', 'plan', '--tools', 'Read,Glob,Grep');
  return args;
}

export async function askClaude(request, message, directory, { spawnProcess = spawn } = {}) {
  const output = fs.openSync(path.join(directory, 'envelope.json'), 'wx');
  const errors = fs.openSync(path.join(directory, 'stderr.log'), 'wx');
  let child;
  try {
    child = spawnProcess(claudeExecutable(), claudeArguments(request), {
      cwd: request.workspace, windowsHide: true,
      env: { ...process.env, AGENT_COLLABORATION_WORKER: '1' }, stdio: ['pipe', output, errors],
    });
    const exited = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    child.stdin.on('error', () => {}); // Exit and the persisted envelope determine the result.
    child.stdin.end(message);
    const exit = await exited;
    let envelope;
    try { envelope = JSON.parse(fs.readFileSync(path.join(directory, 'envelope.json'), 'utf8')); }
    catch { throw new Error(`Claude produced no readable result (exit ${exit.code}); inspect ${directory}, do not blindly resend.`); }
    if (exit.code !== 0 || envelope.is_error || !envelope.session_id || typeof envelope.result !== 'string') {
      throw Object.assign(new Error(`Claude did not complete successfully (exit ${exit.code}): ${envelope.result ?? 'missing result'}`), {
        knownFailure: true, peerResult: { sessionId: envelope.session_id ?? null, exitCode: exit.code,
          permissionDenials: envelope.permission_denials ?? [], reportedError: Boolean(envelope.is_error) },
      });
    }
    if (request.sessionId && envelope.session_id !== request.sessionId) throw new Error('Claude returned a different session ID; inspect the recorded envelope before any follow-up.');
    return { sessionId: envelope.session_id, answer: envelope.result, permissionDenials: envelope.permission_denials ?? [] };
  } finally { fs.closeSync(output); fs.closeSync(errors); }
}
