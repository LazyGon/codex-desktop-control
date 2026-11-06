export async function recoverDiscordMessages({
  bindings, fetchChannel, outbox, shouldRecover, enqueueMessage, isStopping, reason,
}) {
  const outcome = { reason, channels: 0, scanned: 0, recovered: 0, ignored: 0 };
  for (const binding of bindings) {
    if (isStopping()) break;
    const channel = await fetchChannel(binding.channelId).catch((error) => {
      if ([10003, 10008].includes(error.code)) return null;
      throw error;
    });
    if (!channel?.messages?.fetch) continue;
    outcome.channels += 1;
    let cursor = outbox.channelRecoveryCursor(binding.channelId);
    while (!isStopping()) {
      const fetched = await channel.messages.fetch({ after: cursor, limit: 100 });
      const messages = [...fetched.values()]
        .filter((message) => /^\d+$/.test(String(message.id ?? '')) && BigInt(message.id) > BigInt(cursor))
        .sort((left, right) => BigInt(left.id) < BigInt(right.id) ? -1 : 1);
      if (messages.length === 0) break;
      for (const message of messages) {
        if (isStopping()) return outcome;
        outcome.scanned += 1;
        if (shouldRecover(message)) {
          const admission = await enqueueMessage(message);
          if (!admission?.cursorSafe) {
            throw new Error(`Recovered Discord message was not durably admitted: ${message.id}`);
          }
          outcome.recovered += 1;
        } else {
          outcome.ignored += 1;
        }
        // Only the ordered scan owns the checkpoint. A new Gateway event can
        // be admitted immediately without skipping an earlier missed message.
        outbox.advanceChannelRecoveryCursor(binding.channelId, message.id);
        cursor = message.id;
      }
      if (messages.length < 100) break;
    }
  }
  return outcome;
}
