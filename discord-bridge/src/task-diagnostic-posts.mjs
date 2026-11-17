import { createHash } from 'node:crypto';
import { codexRetryStatusText } from './communication-error.mjs';
import { truncate } from './util.mjs';

function advisoryKind(message) {
  if (typeof message !== 'string') return null;
  if (/^Codex is ignoring [1-9]\d* unrecognized configuration settings?\./.test(message)) {
    return 'unrecognizedConfiguration';
  }
  if (message.startsWith('Under-development features enabled: ')
    && message.includes('suppress_unstable_features_warning = true')) {
    return 'unstableFeatures';
  }
  if (/^Combined user instructions use \d+ bytes, above the \d+-byte project_doc_max_bytes setting\. The total includes global and thread instructions\. The limit applies only to project files\.$/.test(message)) {
    return 'instructionSize';
  }
  return null;
}

export class TaskDiagnosticPosts {
  constructor({ stateStore, fetchChannel, send }) {
    this.stateStore = stateStore;
    this.fetchChannel = fetchChannel;
    this.send = send;
    this.pending = new Map();
  }

  async post(binding, notification) {
    const { method, params } = notification;
    // A terminal turn error is rendered by turn/completed's failed card.
    if (method === 'error' && params?.willRetry === false && (params.turnId ?? params.turn?.id)) return;
    const retryStatus = method === 'error' ? codexRetryStatusText(params) : null;
    const content = retryStatus ?? `**${method}**\n${truncate(params?.message ?? JSON.stringify(params), 1800)}`;
    const kind = method === 'warning' ? advisoryKind(params?.message) : null;
    if (!kind) return this.#post(binding, content);

    const fingerprint = createHash('sha256').update(params.message).digest('hex');
    // Serialize each task across channel lookup, durable claim, and Discord send.
    const previous = this.pending.get(binding.threadId) ?? Promise.resolve();
    const pending = previous.catch(() => {}).then(() => this.#post(binding, content, kind, fingerprint));
    this.pending.set(binding.threadId, pending);
    try { return await pending; }
    finally {
      if (this.pending.get(binding.threadId) === pending) this.pending.delete(binding.threadId);
    }
  }

  async #post(binding, content, kind = null, fingerprint = null) {
    if (kind && this.stateStore.binding(binding.threadId)?.startupAdvisories?.[kind]?.fingerprint === fingerprint) return;
    const channel = await this.fetchChannel(binding.channelId).catch(() => null);
    if (!channel) return;
    if (kind) this.#record(binding.threadId, kind, fingerprint, 'unknown');
    // An interrupted/rejected send may already have reached Discord. Keep its claim.
    const result = await this.send(channel, content);
    if (kind) this.#record(binding.threadId, kind, fingerprint, 'posted');
    return result;
  }

  #record(threadId, kind, fingerprint, outcome) {
    const binding = this.stateStore.binding(threadId);
    this.stateStore.setBinding(threadId, {
      startupAdvisories: {
        ...binding?.startupAdvisories,
        [kind]: { fingerprint, outcome },
      },
    });
  }
}
