// No leader or distributed lock: a non-owner must ignore the event before ACK.
export function taskIdFromTopic(channel) {
  return String(channel?.topic ?? '').match(/(?:^|\n)Codex task:\s*([^\s]+)/)?.[1] ?? null;
}

export function localChannelOwned(stateStore, channelId, channel = null) {
  if (stateStore.bindingByChannel?.(channelId)) return true;
  const state = stateStore.snapshot();
  const infrastructure = state.infrastructure ?? {};
  if (['controlChannelId', 'syncChannelId', 'alertsChannelId', 'completionsChannelId',
    'transferTextChannelId'].some((key) => infrastructure[key] === channelId)) return true;
  const categoryId = channel?.parentId;
  if (!categoryId) return false;
  return [infrastructure.controlCategoryId, ...(infrastructure.archiveCategoryIds ?? []),
    ...Object.values(state.projectCategories ?? {}).flatMap((project) => project.categoryIds ?? [])]
    .includes(categoryId);
}

export function selectedTask(value, instanceId) {
  const parts = String(value ?? '').split(':');
  if (parts.length === 2) return { local: parts[0] === instanceId, threadId: parts[1] };
  return { local: true, threadId: value || null };
}

export async function interactionOwned({ interaction, config, stateStore, codex,
  pendingActions = new Map(), pendingRequests = new Map() }) {
  if (interaction.guildId !== config.guildId) return false;
  if (!config.multiPcEnabled) return true;
  const customId = String(interaction.customId ?? '');
  const command = interaction.commandName;
  if (!['codex', 'codex-files'].includes(command) && !customId.startsWith('cx:')) return false;
  const parts = customId.split(':');
  let threadId = null;
  if (interaction.isAutocomplete?.() && interaction.options.getFocused(true).name === 'task') {
    // The focused value is a search query, not an exact task ID yet.
    return localChannelOwned(stateStore, interaction.channelId, interaction.channel);
  }
  if (command) threadId = interaction.options?.getString?.('task') ?? null;
  if (customId === 'cx:open' || customId === 'cx:ui:control:open') {
    const selected = selectedTask(interaction.values?.[0], config.instanceId);
    if (!selected.local) return false;
    threadId = selected.threadId;
  } else if (parts[1] === 'ctl') threadId = parts[3];
  else if (parts[1] === 'ui' && parts[2] === 'task') threadId = parts[4];
  else {
    const sessionKey = parts[1] === 'files' ? parts[3] : parts[2];
    const session = pendingActions.get(sessionKey) ?? pendingRequests.get(sessionKey);
    const sessionScoped = ['projects', 'compose', 'goal', 'review', 'confirm', 'interrupt', 'req', 'q', 'input'].includes(parts[1])
      || (parts[1] === 'files' && ['browse', 'linkedpick', 'nav', 'linkednav'].includes(parts[2]));
    if (sessionScoped && !session) return false;
    threadId ??= session?.threadId ?? session?.request?.params?.threadId ?? null;
    if (sessionScoped && !threadId) return true;
  }
  threadId ??= stateStore.bindingByChannel?.(interaction.channelId)?.threadId
    ?? taskIdFromTopic(interaction.channel);
  if (threadId) {
    try { return await codex.hasLocalThread(threadId); } catch { return false; }
  }
  return localChannelOwned(stateStore, interaction.channelId, interaction.channel);
}
