import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const PERFORMANCE_VALUES = new Set(['fastest', 'medium', 'high', 'very-high', 'pro']);

function moduleUrl(root, relativePath) {
  return pathToFileURL(path.join(root, ...relativePath.split('/'))).href;
}

async function defaultModuleLoader(root) {
  const requiredFiles = [
    'scripts/update-client.mjs',
    'transport/client.mjs',
    'transport/config.mjs',
    'transport/dpapi-cache.mjs',
    'transport/runtime-paths.mjs',
    'transport/session.mjs',
  ];
  for (const relativePath of requiredFiles) {
    const stat = await fs.promises.stat(path.join(root, ...relativePath.split('/'))).catch(() => null);
    if (!stat?.isFile()) {
      throw new Error(`reviewer-accessorの必須ファイルがありません: ${relativePath}`);
    }
  }
  const updater = await import(moduleUrl(root, 'scripts/update-client.mjs'));
  const updateResult = await updater.updateClient({ mode: 'auto' });
  const [client, config, cache, runtime, session] = await Promise.all([
    import(moduleUrl(root, 'transport/client.mjs')),
    import(moduleUrl(root, 'transport/config.mjs')),
    import(moduleUrl(root, 'transport/dpapi-cache.mjs')),
    import(moduleUrl(root, 'transport/runtime-paths.mjs')),
    import(moduleUrl(root, 'transport/session.mjs')),
  ]);
  return { ...updater, ...client, ...config, ...cache, ...runtime, ...session, updateResult };
}

export function normalizeChatgptPerformance(value, fallback = 'fastest') {
  const normalized = String(value ?? fallback).trim().toLowerCase();
  if (!PERFORMANCE_VALUES.has(normalized)) {
    throw new Error(`未対応のChatGPT応答性能です: ${value}`);
  }
  return normalized;
}

export function chatgptConversationIdentity(value, validateConversationUrl) {
  if (typeof validateConversationUrl !== 'function') {
    throw new Error('reviewer-accessorのURL検証APIを読み込めませんでした。');
  }
  const validated = validateConversationUrl(String(value ?? '').trim());
  return {
    conversationId: validated.conversationId,
    conversationUrl: validated.url.href,
  };
}

export class ChatgptService {
  constructor({
    config,
    onStatus = () => undefined,
    moduleLoader = defaultModuleLoader,
  }) {
    this.config = config;
    this.onStatus = onStatus;
    this.moduleLoader = moduleLoader;
    this.modulesPromise = null;
    this.runtimePromise = null;
    this.updateResult = null;
    this.active = new Map();
    this.stopping = false;
  }

  get activeCount() {
    return this.active.size;
  }

  async #modules() {
    if (!this.modulesPromise) {
      this.modulesPromise = (async () => {
        const root = path.resolve(this.config.reviewerAccessorRoot);
        const modules = await this.moduleLoader(root);
        const required = [
          'updateClient',
          'ChatDirectClient',
          'loadDirectConfig',
          'DpapiCredentialCache',
          'migrateLegacyRuntime',
          'validateConversationUrl',
          'authIsFresh',
          'conversationStateIsUsable',
          'integrityIsFresh',
        ];
        for (const name of required) {
          if (typeof modules[name] !== 'function') {
            throw new Error(`reviewer-accessor APIが不足しています: ${name}`);
          }
        }
        this.updateResult = Object.hasOwn(modules, 'updateResult')
          ? modules.updateResult
          : await modules.updateClient({ mode: 'auto' });
        return modules;
      })().catch((error) => {
        this.modulesPromise = null;
        throw error;
      });
    }
    return this.modulesPromise;
  }

  async #runtime() {
    if (!this.runtimePromise) {
      this.runtimePromise = (async () => {
        const modules = await this.#modules();
        const migration = await modules.migrateLegacyRuntime({
          profile: this.config.reviewerAccessorProfile,
          migrateCredentialCache: true,
          onStatus: (message) => this.onStatus('runtime', message),
        });
        return { modules, paths: migration.paths };
      })().catch((error) => {
        this.runtimePromise = null;
        throw error;
      });
    }
    return this.runtimePromise;
  }

  async identity(conversationUrl) {
    const { modules } = await this.#runtime();
    return chatgptConversationIdentity(conversationUrl, modules.validateConversationUrl);
  }

  async status(conversationUrl = null) {
    const { modules, paths } = await this.#runtime();
    const config = await modules.loadDirectConfig(
      path.join(this.config.reviewerAccessorRoot, 'chat-direct.config.json'),
    );
    const selectedUrl = conversationUrl || config.conversationUrl;
    if (!selectedUrl) {
      return {
        ready: true,
        configured: false,
        activeCount: this.activeCount,
        update: this.updateResult,
      };
    }
    const identity = chatgptConversationIdentity(selectedUrl, modules.validateConversationUrl);
    const cache = new modules.DpapiCredentialCache({ filePath: paths.cachePath });
    const session = await cache.read(identity.conversationUrl).catch(() => null);
    return {
      ready: true,
      configured: true,
      ...identity,
      cached: Boolean(session),
      authFresh: Boolean(session && modules.authIsFresh(session)),
      integrityFresh: Boolean(session && modules.integrityIsFresh(session)),
      conversationStateUsable: Boolean(session && modules.conversationStateIsUsable(session)),
      active: this.active.has(identity.conversationId),
      activeCount: this.activeCount,
      update: this.updateResult,
    };
  }

  async send({
    conversationUrl,
    responsePerformance,
    prompt,
    files = [],
    signal = null,
    onText = null,
    onAttachments = null,
  }) {
    if (this.stopping) throw new Error('ChatGPT連携は停止処理中です。');
    const { modules, paths } = await this.#runtime();
    const identity = chatgptConversationIdentity(conversationUrl, modules.validateConversationUrl);
    if (this.active.has(identity.conversationId)) {
      throw new Error('このChatGPT会話では別の応答が進行中です。');
    }
    const performance = normalizeChatgptPerformance(
      responsePerformance,
      this.config.reviewerAccessorResponsePerformance,
    );
    const controller = new AbortController();
    const relayAbort = () => controller.abort(signal?.reason ?? new Error('ChatGPT送信が中断されました。'));
    if (signal?.aborted) relayAbort();
    else signal?.addEventListener?.('abort', relayAbort, { once: true });
    const cache = new modules.DpapiCredentialCache({ filePath: paths.cachePath });
    const client = new modules.ChatDirectClient({
      cache,
      conversationUrl: identity.conversationUrl,
      responsePerformance: performance,
      port: this.config.reviewerAccessorPort,
      profile: this.config.reviewerAccessorProfile,
      runtimeRoot: paths.runtimeRoot,
      onStatus: (message) => this.onStatus('transport', message, identity),
    });
    const operation = client.send(prompt, {
      files,
      signal: controller.signal,
      onText,
      onAttachments,
    });
    this.active.set(identity.conversationId, { controller, operation });
    try {
      return await operation;
    } finally {
      signal?.removeEventListener?.('abort', relayAbort);
      if (this.active.get(identity.conversationId)?.operation === operation) {
        this.active.delete(identity.conversationId);
      }
    }
  }

  async stop(timeoutMs = 300_000) {
    this.stopping = true;
    const operations = [...this.active.values()];
    for (const entry of operations) {
      entry.controller.abort(new Error('Discord Bridgeを安全に停止するためChatGPT送信を中断しました。'));
    }
    if (operations.length === 0) return { timedOut: false };
    let timer = null;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
      timer.unref?.();
    });
    const settled = Promise.allSettled(operations.map((entry) => entry.operation))
      .then((results) => ({ timedOut: false, results }));
    const result = await Promise.race([settled, timeout]);
    if (timer) clearTimeout(timer);
    return result;
  }
}
