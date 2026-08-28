import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const PERFORMANCE_VALUES = new Set(['fastest', 'medium', 'high', 'very-high', 'pro']);

function moduleUrl(root, relativePath) {
  return pathToFileURL(path.join(root, ...relativePath.split('/'))).href;
}

export async function loadReviewerAccessorModules(root) {
  const requiredFiles = [
    'scripts/update-client.mjs',
    'package.json',
  ];
  for (const relativePath of requiredFiles) {
    const stat = await fs.promises.stat(path.join(root, ...relativePath.split('/'))).catch(() => null);
    if (!stat?.isFile()) {
      throw new Error(`reviewer-accessorの必須ファイルがありません: ${relativePath}`);
    }
  }
  const updater = await import(moduleUrl(root, 'scripts/update-client.mjs'));
  const updateResult = await updater.updateClient({ mode: 'auto' });
  const packageJson = JSON.parse(await fs.promises.readFile(path.join(root, 'package.json'), 'utf8'));
  const exportTarget = packageJson?.exports?.['./discord-bridge'];
  if (typeof exportTarget !== 'string' || !exportTarget.startsWith('./')) {
    throw new Error('reviewer-accessorの公開Discord Bridge exportがありません。');
  }
  const entryPath = path.resolve(root, exportTarget);
  const relativeEntry = path.relative(root, entryPath);
  if (relativeEntry.startsWith('..') || path.isAbsolute(relativeEntry)) {
    throw new Error('reviewer-accessorの公開Discord Bridge exportがroot外を指しています。');
  }
  const stat = await fs.promises.stat(entryPath).catch(() => null);
  if (!stat?.isFile()) {
    throw new Error('reviewer-accessorの公開Discord Bridge entrypointがありません。');
  }
  const bridge = await import(pathToFileURL(entryPath).href);
  return { ...updater, ...bridge, updateResult };
}

export function normalizeChatgptPerformance(value, fallback = 'fastest') {
  const normalized = String(value ?? fallback).trim().toLowerCase();
  if (!PERFORMANCE_VALUES.has(normalized)) {
    throw new Error(`未対応のChatGPT応答性能です: ${value}`);
  }
  return normalized;
}

export function chatgptConversationIdentity(value) {
  let url;
  try {
    url = new URL(String(value ?? '').trim());
  } catch {
    throw new Error('ChatGPT会話URLが不正です。');
  }
  if (url.origin !== 'https://chatgpt.com') {
    throw new Error('ChatGPT会話URLはhttps://chatgpt.comを使用してください。');
  }
  const conversationId = url.pathname.match(/\/c\/([0-9a-f-]{36})(?:\/|$)/i)?.[1];
  if (!conversationId) {
    throw new Error('ChatGPT会話URLには/c/<conversation ID>が必要です。');
  }
  return {
    conversationId: conversationId.toLowerCase(),
    conversationUrl: url.href,
  };
}

function chatgptStatusText(event) {
  if (!event || typeof event !== 'object') return String(event ?? '');
  return [event.phase, event.code, event.submissionStatus].filter(Boolean).join(' ');
}

export class ChatgptService {
  constructor({
    config,
    onStatus = () => undefined,
    moduleLoader = loadReviewerAccessorModules,
  }) {
    this.config = config;
    this.onStatus = onStatus;
    this.moduleLoader = moduleLoader;
    this.modulesPromise = null;
    this.updateResult = null;
    this.active = new Map();
    this.activeHistory = new Map();
    this.stopping = false;
  }

  get activeCount() {
    return this.active.size;
  }

  get activeHistoryCount() {
    return this.activeHistory.size;
  }

  async #modules() {
    if (!this.modulesPromise) {
      this.modulesPromise = (async () => {
        const root = path.resolve(this.config.reviewerAccessorRoot);
        const modules = await this.moduleLoader(root);
        const required = [
          'updateClient',
          'DiscordReviewerAccessor',
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

  async identity(conversationUrl) {
    await this.#modules();
    return chatgptConversationIdentity(conversationUrl);
  }

  async status(conversationUrl = null) {
    const modules = await this.#modules();
    if (!conversationUrl) {
      return {
        ready: true,
        configured: false,
        activeCount: this.activeCount,
        activeHistoryCount: this.activeHistoryCount,
        profile: this.config.reviewerAccessorProfile,
        schemaVersion: modules.DISCORD_REVIEWER_ACCESSOR_SCHEMA_VERSION ?? null,
        transport: 'reviewer-accessor-discord-bridge',
        update: this.updateResult,
      };
    }
    const identity = chatgptConversationIdentity(conversationUrl);
    return {
      ready: true,
      configured: true,
      ...identity,
      profile: this.config.reviewerAccessorProfile,
      schemaVersion: modules.DISCORD_REVIEWER_ACCESSOR_SCHEMA_VERSION ?? null,
      transport: 'reviewer-accessor-discord-bridge',
      browserSessionCheck: 'on-send',
      active: this.active.has(identity.conversationId),
      activeCount: this.activeCount,
      historyActive: this.activeHistory.has(identity.conversationId),
      activeHistoryCount: this.activeHistoryCount,
      update: this.updateResult,
    };
  }

  async send({
    conversationUrl,
    responsePerformance,
    prompt,
    files = [],
    returnedFileOutputRoot = null,
    signal = null,
    onText = null,
    onAttachments = null,
  }) {
    if (this.stopping) throw new Error('ChatGPT連携は停止処理中です。');
    const modules = await this.#modules();
    const identity = chatgptConversationIdentity(conversationUrl);
    if (this.active.has(identity.conversationId)) {
      throw new Error('このChatGPT会話では別の応答が進行中です。');
    }
    if (this.activeHistory.has(identity.conversationId)) {
      throw new Error('このChatGPT会話では履歴同期が進行中です。完了後に送信してください。');
    }
    const performance = normalizeChatgptPerformance(
      responsePerformance,
      this.config.reviewerAccessorResponsePerformance,
    );
    const controller = new AbortController();
    const relayAbort = () => controller.abort(signal?.reason ?? new Error('ChatGPT送信が中断されました。'));
    if (signal?.aborted) relayAbort();
    else signal?.addEventListener?.('abort', relayAbort, { once: true });
    const accessor = new modules.DiscordReviewerAccessor();
    const operation = accessor.send({
      conversationUrl: identity.conversationUrl,
      files,
      port: this.config.reviewerAccessorPort,
      profile: this.config.reviewerAccessorProfile,
      prompt,
      responsePerformance: performance,
      ...(returnedFileOutputRoot ? { returnedFileOutputRoot } : {}),
      signal: controller.signal,
      onStatus: (event) => this.onStatus('transport', chatgptStatusText(event), identity),
    });
    this.active.set(identity.conversationId, { controller, operation });
    try {
      const result = await operation;
      onText?.(result.assistantText);
      onAttachments?.(result.assistantAttachments);
      return result;
    } finally {
      signal?.removeEventListener?.('abort', relayAbort);
      if (this.active.get(identity.conversationId)?.operation === operation) {
        this.active.delete(identity.conversationId);
      }
    }
  }

  async readHistory({
    conversationUrl,
    limit = 5,
    signal = null,
  }) {
    if (this.stopping) throw new Error('ChatGPT連携は停止処理中です。');
    const modules = await this.#modules();
    const identity = chatgptConversationIdentity(conversationUrl);
    if (this.active.has(identity.conversationId)) {
      throw new Error('このChatGPT会話では応答が進行中のため、履歴を同期できません。');
    }
    if (this.activeHistory.has(identity.conversationId)) {
      throw new Error('このChatGPT会話では履歴同期が進行中です。');
    }
    const accessor = new modules.DiscordReviewerAccessor();
    if (typeof accessor.readHistory !== 'function') {
      throw new Error('reviewer-accessorの公開履歴APIがありません。');
    }
    const controller = new AbortController();
    const relayAbort = () => controller.abort(signal?.reason ?? new Error('ChatGPT履歴同期が中断されました。'));
    if (signal?.aborted) relayAbort();
    else signal?.addEventListener?.('abort', relayAbort, { once: true });
    const operation = accessor.readHistory({
      conversationUrl: identity.conversationUrl,
      limit,
      port: this.config.reviewerAccessorPort,
      profile: this.config.reviewerAccessorProfile,
      signal: controller.signal,
      onStatus: (event) => this.onStatus('history', chatgptStatusText(event), identity),
    });
    this.activeHistory.set(identity.conversationId, { controller, operation });
    try {
      return await operation;
    } finally {
      signal?.removeEventListener?.('abort', relayAbort);
      if (this.activeHistory.get(identity.conversationId)?.operation === operation) {
        this.activeHistory.delete(identity.conversationId);
      }
    }
  }

  async stop(timeoutMs = 300_000) {
    this.stopping = true;
    const operations = [...this.active.values(), ...this.activeHistory.values()];
    for (const entry of operations) {
      entry.controller.abort(new Error('Discord Bridgeを安全に停止するためChatGPT操作を中断しました。'));
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
