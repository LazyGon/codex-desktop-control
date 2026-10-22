// Select only descendants of mirrored ordinary tasks. Metadata discovery never
// hydrates parent transcripts and does not grant input authority over children.
export function mirroredDescendants(threads, parentIds) {
  const children = new Map();
  for (const thread of threads) {
    const spawn = thread.source?.subAgent?.thread_spawn
      ?? thread.source?.subAgent?.threadSpawn;
    const parentId = thread.parentThreadId ?? spawn?.parent_thread_id ?? spawn?.parentThreadId;
    if (!parentId || thread.ephemeral) continue;
    const group = children.get(parentId) ?? [];
    group.push(thread);
    children.set(parentId, group);
  }
  const visited = new Set(parentIds);
  const queue = [...visited];
  const result = [];
  for (let index = 0; index < queue.length; index += 1) {
    for (const child of children.get(queue[index]) ?? []) {
      if (visited.has(child.id)) continue;
      visited.add(child.id);
      queue.push(child.id);
      result.push(child);
    }
  }
  return result;
}
