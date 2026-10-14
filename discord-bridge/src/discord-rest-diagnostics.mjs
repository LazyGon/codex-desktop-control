function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function channelCreateResponseMetadata(response) {
  const header = (name) => response.headers?.get?.(name);
  return {
    status: finite(response.status),
    limit: finite(header('X-RateLimit-Limit')),
    remaining: finite(header('X-RateLimit-Remaining')),
    resetAfterMs: finite(header('X-RateLimit-Reset-After')) === null ? null
      : finite(header('X-RateLimit-Reset-After')) * 1000,
    retryAfterMs: finite(header('Retry-After')) === null ? null : finite(header('Retry-After')) * 1000,
    scope: ['user','global','shared'].includes(header('X-RateLimit-Scope')) ? header('X-RateLimit-Scope') : null,
  };
}

export function attachChannelCreateDiagnostics(rest, guildId, log = () => {}) {
  let lastEvent = null;
  const emit = (details) => {
    lastEvent = { at: new Date().toISOString(), ...details };
    log('guild-channel-create-rest', lastEvent);
  };
  const original = rest.options.makeRequest;
  rest.options.makeRequest = async (url, options) => {
    let matches = false;
    try {
      const parsed = new URL(url);
      matches = parsed.hostname === 'discord.com'
        && parsed.pathname === `/api/v${rest.options.version}/guilds/${guildId}/channels`
        && String(options.method).toUpperCase() === 'POST';
    } catch { /* Unrelated routes remain unchanged. */ }
    if (!matches) return original.call(rest.options, url, options);
    emit({ phase: 'sending' });
    try {
      const response = await original.call(rest.options, url, options);
      emit({ phase: 'response', ...channelCreateResponseMetadata(response) });
      if (response.status >= 500) {
        const failure = new Error('CHANNEL_CREATE_HTTP_RESULT_UNKNOWN');
        failure.name = 'ChannelCreateTransportError';
        failure.status = response.status;
        throw failure;
      }
      return response;
    } catch (error) {
      if (error.name === 'ChannelCreateTransportError') throw error;
      emit({ phase: 'network-error', errorType: /^[A-Za-z0-9_]+$/.test(error.name) ? error.name : 'Error',
        errorCode: /^[A-Z0-9_]+$/.test(error.code ?? '') ? error.code : null });
      // Discord.js retries AbortError/UND_ERR_* failures automatically. A write
      // may already have succeeded, so leave creation fenced instead of replaying.
      const failure = new Error('CHANNEL_CREATE_NETWORK_RESULT_UNKNOWN');
      failure.name = 'ChannelCreateTransportError';
      throw failure;
    }
  };
  rest.on('rateLimited', (details) => {
    if (String(details.method).toUpperCase() !== 'POST'
      || details.majorParameter !== guildId || details.route !== '/guilds/:id/channels') return;
    emit({ phase: 'rate-limited', global: Boolean(details.global),
      retryAfterMs: finite(details.retryAfter), resetAfterMs: finite(details.timeToReset),
      sublimitTimeoutMs: finite(details.sublimitTimeout), limit: finite(details.limit) });
  });
  return { snapshot: () => lastEvent ? { ...lastEvent } : null };
}
