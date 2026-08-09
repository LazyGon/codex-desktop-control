import fs from 'node:fs';
import readline from 'node:readline';

function messageText(payload) {
  return (payload?.content ?? [])
    .map((part) => part?.text ?? '')
    .filter(Boolean)
    .join('\n');
}

function comparableText(value) {
  return String(value ?? '').replace(/\r\n/g, '\n').trim();
}

export async function readSessionTurnCardOrder(sessionPath, turnId, userItems = []) {
  if (!sessionPath || !turnId) return [];
  let stream;
  const timeline = [];
  try {
    stream = fs.createReadStream(sessionPath, { encoding: 'utf8' });
    const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
    let currentTurnId = null;
    for await (const line of lines) {
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        // The final line can be incomplete while Codex is appending to the session.
        continue;
      }
      if (entry?.type === 'turn_context') {
        currentTurnId = entry.payload?.turn_id ?? entry.payload?.turnId ?? null;
        continue;
      }
      if (currentTurnId !== turnId || entry?.type !== 'response_item') continue;
      const payload = entry.payload;
      if (payload?.type === 'message' && payload.role === 'user') {
        timeline.push({ kind: 'session-user', text: messageText(payload) });
      } else if (payload?.id && (
        (payload.type === 'message' && payload.role === 'assistant')
        || payload.type === 'reasoning'
      )) {
        timeline.push({ kind: 'detail', id: payload.id });
      }
    }
  } catch {
    stream?.destroy();
    return [];
  }

  const availableUsers = userItems.map((item, index) => ({
    item,
    index,
    text: comparableText(item.text),
    claimed: false,
  }));
  const sessionUsers = timeline
    .map((item, index) => ({ item, index, text: comparableText(item.text), matched: null }))
    .filter(({ item }) => item.kind === 'session-user');

  for (const sessionUser of sessionUsers) {
    const match = availableUsers.find((candidate) => !candidate.claimed && candidate.text === sessionUser.text);
    if (!match) continue;
    match.claimed = true;
    sessionUser.matched = match.item.id;
  }

  const unmatchedSessionUsers = sessionUsers.filter((item) => !item.matched);
  const unmatchedUsers = availableUsers.filter((item) => !item.claimed);
  if (unmatchedSessionUsers.length === unmatchedUsers.length) {
    unmatchedSessionUsers.forEach((sessionUser, index) => {
      sessionUser.matched = unmatchedUsers[index].item.id;
    });
  }

  const userIdsByTimelineIndex = new Map(
    sessionUsers.filter((item) => item.matched).map((item) => [item.index, item.matched]),
  );
  const order = [];
  const seen = new Set();
  timeline.forEach((item, index) => {
    const ordered = item.kind === 'session-user'
      ? { kind: 'user', id: userIdsByTimelineIndex.get(index) }
      : item;
    if (!ordered.id) return;
    const key = `${ordered.kind}:${ordered.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    order.push(ordered);
  });
  return order;
}
