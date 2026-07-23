import { randomKey } from './util.mjs';

const OUTPUT_FIELDS = new Set(['aggregatedOutput', 'output', 'stdout', 'stderr']);

export class ClientToolUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ClientToolUnavailableError';
  }
}

function objectArguments(value) {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Tool arguments must be an object.');
  }
  return value;
}

function requiredString(value, field, maximum = 100_000) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${field} must be a non-empty string.`);
  }
  if (value.length > maximum) throw new Error(`${field} is too long.`);
  return value;
}

function optionalLocalHost(hostId) {
  if (hostId !== undefined && hostId !== null && hostId !== 'local') {
    throw new ClientToolUnavailableError(
      `Remote host ${hostId} is not available through Codex Discord Remote.`,
    );
  }
}

function boundedInteger(value, fallback, minimum, maximum, field) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${field} must be an integer from ${minimum} through ${maximum}.`);
  }
  return value;
}

function threadSummary(thread, archived = false) {
  return {
    threadId: thread.id,
    hostId: 'local',
    title: thread.name ?? thread.preview ?? null,
    description: thread.preview ?? null,
    cwd: thread.cwd ?? null,
    status: thread.status ?? null,
    archived,
    createdAt: thread.createdAt ?? null,
    updatedAt: thread.updatedAt ?? null,
  };
}

function sanitizedValue(value, includeOutputs, maximumOutputChars, key = null) {
  if (!includeOutputs && key && OUTPUT_FIELDS.has(key)) return undefined;
  if (typeof value === 'string' && key && OUTPUT_FIELDS.has(key)) {
    return value.length <= maximumOutputChars
      ? value
      : `${value.slice(0, maximumOutputChars)}\n… truncated`;
  }
  if (Array.isArray(value)) {
    return value
      .map((entry) => sanitizedValue(entry, includeOutputs, maximumOutputChars))
      .filter((entry) => entry !== undefined);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .map(([entryKey, entryValue]) => [
        entryKey,
        sanitizedValue(entryValue, includeOutputs, maximumOutputChars, entryKey),
      ])
      .filter(([, entryValue]) => entryValue !== undefined));
  }
  return value;
}

function targetThreadId(args, context) {
  return requiredString(args.threadId ?? context.threadId, 'threadId', 500);
}

export class ClientToolRouter {
  constructor({ codex, automationStore }) {
    this.codex = codex;
    this.automationStore = automationStore;
  }

  async execute(namespace, tool, rawArguments, context = {}) {
    if (namespace !== 'codex_app') {
      throw new ClientToolUnavailableError(
        `Client-side dynamic tool ${namespace}/${tool} requires its owning Desktop client or connector and is not available through Codex Discord Remote.`,
      );
    }
    const args = objectArguments(rawArguments);
    switch (tool) {
      case 'automation_update':
        return this.automationStore.execute(args, context);
      case 'list_threads':
        return this.#listThreads(args);
      case 'read_thread':
        return this.#readThread(args);
      case 'send_message_to_thread':
        return this.#sendMessage(args);
      case 'set_thread_archived':
        return this.#setArchived(args, context);
      case 'set_thread_title':
        return this.#setTitle(args, context);
      case 'fork_thread':
        return this.#forkThread(args, context);
      case 'list_projects':
        return { projects: this.automationStore.listProjects() };
      case 'create_thread':
        return this.#createThread(args);
      case 'set_thread_pinned':
        throw new ClientToolUnavailableError(
          'set_thread_pinned is Desktop-local UI state and has no equivalent Codex app-server operation.',
        );
      case 'wait_threads':
        throw new ClientToolUnavailableError(
          'wait_threads depends on Desktop event cursors and background waiting; use list_threads or read_thread through Discord instead.',
        );
      case 'handoff_thread':
      case 'get_handoff_status':
        throw new ClientToolUnavailableError(
          `${tool} requires Codex Desktop worktree and host orchestration and cannot be reproduced safely by the Discord bridge.`,
        );
      case 'navigate_to_codex_page':
      case 'read_thread_terminal':
      case 'load_workspace_dependencies':
        throw new ClientToolUnavailableError(
          `${tool} operates on the interactive Codex Desktop client and is not meaningful through Discord.`,
        );
      default:
        throw new ClientToolUnavailableError(
          `Client-side dynamic tool codex_app/${tool} has no safe Discord bridge implementation.`,
        );
    }
  }

  async #listThreads(args) {
    const limit = boundedInteger(args.limit, 20, 1, 100, 'limit');
    const query = args.query === undefined || args.query === null
      ? null
      : requiredString(args.query, 'query', 500);
    const active = await this.codex.listThreads({ limit, search: query, archived: false });
    const threads = (active.data ?? []).map((thread) => threadSummary(thread, false));
    if (threads.length < limit) {
      const archived = await this.codex.listThreads({
        limit: limit - threads.length,
        search: query,
        archived: true,
      });
      threads.push(...(archived.data ?? []).map((thread) => threadSummary(thread, true)));
    }
    return { threads };
  }

  async #readThread(args) {
    optionalLocalHost(args.hostId);
    if (args.cursor !== undefined && args.cursor !== null) {
      throw new ClientToolUnavailableError(
        'Older-turn cursors are maintained by Codex Desktop and are not available through the app-server read fallback.',
      );
    }
    const threadId = requiredString(args.threadId, 'threadId', 500);
    const turnLimit = boundedInteger(args.turnLimit, 5, 1, 50, 'turnLimit');
    const maximumOutputChars = boundedInteger(
      args.maxOutputCharsPerItem,
      4_000,
      100,
      50_000,
      'maxOutputCharsPerItem',
    );
    const result = await this.codex.readThread(threadId);
    const thread = result.thread ?? {};
    const turns = (thread.turns ?? []).slice(-turnLimit).map((turn) => sanitizedValue(
      turn,
      args.includeOutputs === true,
      maximumOutputChars,
    ));
    return {
      hostId: 'local',
      thread: {
        ...sanitizedValue(thread, false, maximumOutputChars),
        turns,
      },
      cursor: null,
    };
  }

  async #sendMessage(args) {
    optionalLocalHost(args.hostId);
    const threadId = requiredString(args.threadId, 'threadId', 500);
    const prompt = requiredString(args.prompt, 'prompt');
    const settings = {};
    if (args.model !== undefined) settings.model = requiredString(args.model, 'model', 500);
    if (args.thinking !== undefined) {
      settings.reasoningEffort = requiredString(args.thinking, 'thinking', 100);
    }
    if (Object.keys(settings).length) await this.codex.updateThreadSettings(threadId, settings);
    const result = await this.codex.deliver(
      threadId,
      prompt,
      null,
      `discord-tool-${randomKey()}`,
    );
    return { hostId: 'local', threadId, mode: result.mode, turnId: result.turnId };
  }

  async #setArchived(args, context) {
    optionalLocalHost(args.hostId);
    if (typeof args.archived !== 'boolean') throw new Error('archived must be a boolean.');
    const threadId = targetThreadId(args, context);
    if (args.archived) await this.codex.archiveThread(threadId);
    else await this.codex.unarchiveThread(threadId);
    return { hostId: 'local', threadId, archived: args.archived };
  }

  async #setTitle(args, context) {
    const threadId = targetThreadId(args, context);
    const title = requiredString(args.title, 'title', 200);
    await this.codex.setThreadName(threadId, title);
    return { hostId: 'local', threadId, title };
  }

  async #forkThread(args, context) {
    if (args.environment?.type === 'worktree') {
      throw new ClientToolUnavailableError(
        'Worktree forks require Codex Desktop orchestration; same-directory forks are supported through Discord.',
      );
    }
    const threadId = targetThreadId(args, context);
    const result = await this.codex.forkThread(threadId);
    if (!result.thread?.id) throw new Error('thread/fork did not return a task ID.');
    return { hostId: 'local', threadId: result.thread.id };
  }

  async #createThread(args) {
    const prompt = requiredString(args.prompt, 'prompt');
    const target = args.target;
    if (!target || target.type !== 'project') {
      throw new ClientToolUnavailableError(
        'Projectless task creation requires Codex Desktop output-directory bookkeeping; choose a saved local project.',
      );
    }
    if (target.environment?.type !== 'local') {
      throw new ClientToolUnavailableError(
        'Worktree task creation requires Codex Desktop orchestration; local project tasks are supported through Discord.',
      );
    }
    const project = this.automationStore.project(target.projectId);
    const cwd = project.rootPaths[0];
    const started = await this.codex.startThread(cwd);
    const threadId = started.thread?.id;
    if (!threadId) throw new Error('thread/start did not return a task ID.');
    const settings = {};
    if (args.model !== undefined) settings.model = requiredString(args.model, 'model', 500);
    if (args.thinking !== undefined) {
      settings.reasoningEffort = requiredString(args.thinking, 'thinking', 100);
    }
    if (Object.keys(settings).length) await this.codex.updateThreadSettings(threadId, settings);
    const delivered = await this.codex.deliver(
      threadId,
      prompt,
      null,
      `discord-tool-${randomKey()}`,
    );
    return {
      hostId: 'local',
      threadId,
      mode: delivered.mode,
      turnId: delivered.turnId,
      projectId: project.projectId,
    };
  }
}
