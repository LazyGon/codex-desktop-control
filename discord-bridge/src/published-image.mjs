// Published images are snapshots of a tool result, not a live view of its path.
// Reconnect can reuse the Discord copy without reopening a later-mutated file.
export function isPublishedImageCopy(message, recorded, { botId, threadId, turnId, itemId }) {
  if (!message || message.author?.id !== botId || !recorded?.attachments?.length) return false;
  const fields = (message.embeds ?? []).flatMap(embed => embed.fields ?? []);
  const field = name => fields.find(value => value.name === name)?.value?.replaceAll('`', '');
  if (field('Task') !== threadId || field('Turn') !== turnId || field('Item') !== itemId) return false;
  const attachments = [...(message.attachments?.values() ?? [])];
  return recorded.attachments.every(expected => attachments.some(actual =>
    actual.name === expected.name && actual.size === expected.size));
}

export class ImageReplayQueue {
  constructor() {
    this.items = new Map();
    this.restores = new Map();
    this.tail = Promise.resolve();
  }

  async forItem(key, operation) {
    if (this.items.has(key)) return this.items.get(key);
    const pending = operation();
    this.items.set(key, pending);
    try { return await pending; }
    finally { this.items.delete(key); }
  }

  restore(threadId, operation) {
    const pending = this.tail.catch(() => {}).then(operation).finally(() => {
      if (this.restores.get(threadId) === pending) this.restores.delete(threadId);
    });
    this.restores.set(threadId, pending);
    this.tail = pending;
    return pending;
  }
}
