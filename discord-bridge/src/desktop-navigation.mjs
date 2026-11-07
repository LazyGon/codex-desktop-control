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

  async prepare(client) {
    let context = this.#contexts.get(client);
    if (!context) {
      // A cold task cannot host an MCP call. Keep a service-owned, in-memory
      // context on this connection; never borrow a user's task or start a turn.
      context = { thread: this.#startContext(client), available: false };
      this.#contexts.set(client, context);
    }
    const threadId = await context.thread;
    if (!context.available) {
      const catalog = await client.call('mcpServerStatus/list', {
        threadId, serverName: SERVER, detail: 'toolsAndAuthOnly',
      });
      const server = catalog?.data?.find(entry => entry.name === SERVER);
      if (!server?.tools?.[TOOL]) throw new Error('Desktop navigation is unavailable.');
      context.available = true;
    }
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
