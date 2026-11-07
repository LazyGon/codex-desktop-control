const SERVER = 'codex_app';
const TOOL = 'navigate_to_codex_page';

function navigated(result) {
  if (result?.isError === true) return false;
  if (result?.structuredContent != null) return result.structuredContent.navigated === true;
  const text = result?.content?.find(item => item.type === 'text')?.text;
  try { return JSON.parse(text)?.navigated === true; }
  catch { return false; }
}

export class DesktopNavigation {
  #contexts = new WeakMap();

  constructor({ retryDelayMs = 0, clock = Date.now, log = () => {} } = {}) {
    Object.assign(this, { retryDelayMs, clock, log });
  }

  prepare(client) {
    let context = this.#contexts.get(client);
    if (!context || (context.retryAt != null && this.clock() >= context.retryAt)) {
      // A cold task cannot host an MCP call. Keep a service-owned, in-memory
      // context on this connection; never borrow a user's task or start a turn.
      context = {};
      this.#contexts.set(client, context);
      context.ready = this.#prepareContext(client, context);
    }
    return context.ready;
  }

  async #prepareContext(client, context) {
    const threadId = await this.#startContext(client);
    let server;
    let reason = 'navigation-tool-unavailable';
    try {
      const catalog = await client.call('mcpServerStatus/list', {
        threadId, serverName: SERVER, detail: 'toolsAndAuthOnly',
      });
      server = catalog?.data?.find(entry => entry.name === SERVER);
    } catch {
      reason = 'catalog-read-failed';
    }
    if (!server?.tools?.[TOOL]) {
      this.log('desktop-navigation-context-unavailable', { contextThreadId: threadId, reason });
      // No navigation was requested. An MCP startup failure is cached by
      // this session, so retire it rather than reading its catalog forever.
      const released = await client.call('thread/unsubscribe', { threadId });
      if (!['unsubscribed', 'notSubscribed', 'notLoaded'].includes(released?.status)) {
        throw new Error('Desktop navigation context release was not confirmed.');
      }
      context.retryAt = this.clock() + this.retryDelayMs;
      this.log('desktop-navigation-context-released', { contextThreadId: threadId, status: released.status });
      return null;
    }
    this.log('desktop-navigation-context-ready', { contextThreadId: threadId });
    return async (target) => navigated(await client.call('mcpServer/tool/call', {
      threadId, server: SERVER, tool: TOOL, arguments: { threadId: target },
    }));
  }

  async #startContext(client) {
    // Do not replay a failed or uncertain creation on this connection.
    const { thread } = await client.call('thread/start', { ephemeral: true });
    if (!thread?.id || thread.ephemeral !== true || thread.path != null) {
      throw new Error('Desktop navigation requires a transient context.');
    }
    return thread.id;
  }
}
