const TASK_ID = /^[a-zA-Z0-9_-]{8,100}$/;
const PROJECT_ID = /^[a-zA-Z0-9_-]{1,100}$/;
const ACTIONS = new Set(['status', 'projects', 'read', 'create', 'send', 'steer', 'deliver', 'interrupt', 'archive']);
const EFFECTS = new Set(['create', 'send', 'steer', 'deliver', 'interrupt', 'archive']);

export function validateTaskOperation(operation) {
  if (!operation || typeof operation !== 'object' || Array.isArray(operation)
    || !ACTIONS.has(operation.action)) throw new Error('Unknown task operation.');
  const action = operation.action;
  const fields = Object.keys(operation).sort();
  const allowed = {
    status: ['action'], projects: ['action'],
    read: ['action', 'threadId'],
    create: ['action', 'projectId', 'prompt'],
    send: ['action', 'threadId', 'prompt'],
    steer: ['action', 'threadId', 'prompt'],
    deliver: ['action', 'threadId', 'prompt'],
    interrupt: ['action', 'threadId'],
    archive: ['action', 'threadId'],
  }[action];
  if (fields.some((field) => !allowed.includes(field))) throw new Error('Unexpected task operation field.');
  if (allowed.includes('threadId') && !TASK_ID.test(operation.threadId ?? '')) {
    throw new Error('An exact task ID is required.');
  }
  if (allowed.includes('projectId') && !PROJECT_ID.test(operation.projectId ?? '')) {
    throw new Error('A registered project ID is required.');
  }
  if (allowed.includes('prompt') && (typeof operation.prompt !== 'string'
    || !operation.prompt.trim() || operation.prompt.length > 16000)) {
    throw new Error('A nonempty prompt of at most 16000 characters is required.');
  }
  return operation;
}

export function taskOperationIsEffectful(action) { return EFFECTS.has(action); }

function recentMessages(thread, limit = 16, characterLimit = 4000) {
  const messages = [];
  for (const turn of thread.turns ?? []) {
    for (const item of turn.items ?? []) {
      if (!['userMessage', 'agentMessage'].includes(item.type)) continue;
      const text = item.type === 'agentMessage' ? item.text ?? ''
        : (item.content ?? []).map((entry) => entry.text ?? '').filter(Boolean).join('\n');
      messages.push({ turnId: turn.id, status: turn.status, role: item.type === 'userMessage' ? 'user' : 'assistant',
        text: String(text).slice(0, characterLimit) });
    }
  }
  return messages.slice(-limit);
}

export async function executeTaskOperation(operation, { codex, stateStore, getLocalTasks }) {
  validateTaskOperation(operation);
  if (!codex.connected) throw new Error('The local AppServer is unavailable.');
  if (operation.action === 'status') return { connected: true };
  if (operation.action === 'projects') {
    return { projects: stateStore.projectCategories()
      .filter((project) => project.path && project.path !== '(no project)'
        && !stateStore.hiddenProject(project.projectKey))
      .map((project) => ({ id: project.projectId, path: project.path, name: project.name ?? null })) };
  }
  if (operation.action === 'create') {
    const project = stateStore.projectCategories().find((candidate) =>
      candidate.projectId === operation.projectId && candidate.path && candidate.path !== '(no project)'
      && !stateStore.hiddenProject(candidate.projectKey));
    if (!project) throw new Error('The target project is not registered or is hidden.');
    const started = await codex.startThread(project.path);
    const threadId = started.thread?.id;
    if (!threadId) throw new Error('Task creation did not return an ID.');
    const sent = await codex.send(threadId, operation.prompt);
    return { threadId, turnId: sent.turnId, mode: 'send', projectId: project.projectId };
  }

  // Inventory is already filtered for hidden projects, subagents and foreign
  // task IDs. Repeat it on the owning PC immediately before every operation.
  const visible = await getLocalTasks(null);
  if (!visible.some((thread) => thread.id === operation.threadId)) {
    throw new Error('The task is not present in this PC\'s visible active inventory.');
  }
  const metadata = await codex.threadMetadata(operation.threadId);
  if (metadata.thread?.id !== operation.threadId) throw new Error('The task is not owned by this AppServer.');

  if (operation.action === 'read') {
    const result = await codex.readThread(operation.threadId);
    return { threadId: operation.threadId, name: result.thread?.name ?? null,
      status: result.thread?.status ?? null, messages: recentMessages(result.thread ?? {}) };
  }
  if (operation.action === 'interrupt') return codex.interrupt(operation.threadId);
  if (operation.action === 'archive') {
    if (await codex.activeTurn(operation.threadId)) throw new Error('Interrupt the active turn before archiving.');
    return codex.archiveThread(operation.threadId);
  }
  const result = await codex[operation.action](operation.threadId, operation.prompt);
  return { threadId: operation.threadId, turnId: result.turnId, mode: result.mode };
}
