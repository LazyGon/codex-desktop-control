// Page persisted history from newest to oldest rather than fetching every tool
// result before taking the last few conversation messages.
export async function recentThreadMessages(client, metadata, messageLimit) {
  if (!Number.isInteger(messageLimit) || messageLimit < 1) {
    throw new Error('messageLimit must be a positive integer.');
  }
  const newestMessages = [];
  const seenItems = new Set();
  const seenCursors = new Set();
  let cursor = null;
  do {
    const page = await client.call('thread/items/list', {
      threadId: metadata.id,
      limit: Math.min(100, Math.max(16, messageLimit * 2)),
      sortDirection: 'desc',
      ...(cursor ? { cursor } : {}),
    }, 60_000);
    for (const entry of page.data ?? []) {
      const item = entry.item;
      if (item?.type !== 'userMessage' && item?.type !== 'agentMessage') continue;
      const key = `${entry.turnId}:${item.id}`;
      if (seenItems.has(key)) continue;
      seenItems.add(key);
      newestMessages.push(entry);
      if (newestMessages.length >= messageLimit) break;
    }
    if (newestMessages.length >= messageLimit) break;
    cursor = page.nextCursor ?? null;
    if (cursor && seenCursors.has(cursor)) throw new Error('thread/items/list repeated cursor.');
    if (cursor) seenCursors.add(cursor);
  } while (cursor);

  const neededTurns = new Set(newestMessages.map(entry => entry.turnId));
  const descriptors = new Map();
  seenCursors.clear();
  cursor = null;
  while (neededTurns.size > 0) {
    const page = await client.call('thread/turns/list', {
      threadId: metadata.id, limit: 100, sortDirection: 'desc', itemsView: 'notLoaded',
      ...(cursor ? { cursor } : {}),
    }, 60_000);
    for (const turn of page.data ?? []) {
      if (!neededTurns.delete(turn.id)) continue;
      descriptors.set(turn.id, turn);
    }
    if (neededTurns.size === 0) break;
    cursor = page.nextCursor ?? null;
    if (!cursor) throw new Error('Recent message turn metadata was unavailable; retry the read.');
    if (seenCursors.has(cursor)) throw new Error('thread/turns/list repeated cursor.');
    seenCursors.add(cursor);
  }
  const turns = new Map();
  for (const entry of newestMessages.reverse()) {
    if (!turns.has(entry.turnId)) {
      turns.set(entry.turnId, { ...descriptors.get(entry.turnId), items: [] });
    }
    turns.get(entry.turnId).items.push(entry.item);
  }
  return { ...metadata, turns: [...turns.values()] };
}
