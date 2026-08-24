import fs from 'node:fs';
import readline from 'node:readline';

export async function readSessionForkInfo(sessionPath, threadId) {
  if (!sessionPath || !threadId) return null;
  let stream;
  try {
    stream = fs.createReadStream(sessionPath, { encoding: 'utf8' });
    const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line);
      if (entry?.type !== 'session_meta') return null;
      const payload = entry.payload ?? {};
      if (payload.id !== threadId) return null;
      const forkedAtMs = Date.parse(entry.timestamp ?? payload.timestamp ?? '');
      return {
        forkedFromThreadId: payload.forked_from_id ?? payload.forkedFromId ?? null,
        forkedAtMs: Number.isFinite(forkedAtMs) ? forkedAtMs : null,
      };
    }
  } catch {
    return null;
  } finally {
    stream?.destroy();
  }
  return null;
}
