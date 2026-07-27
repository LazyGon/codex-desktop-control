const TRANSIENT_CODES = new Set([
  'EAI_AGAIN',
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTDOWN',
  'EHOSTUNREACH',
  'ENETDOWN',
  'ENETRESET',
  'ENETUNREACH',
  'ENOTFOUND',
  'EPIPE',
  'ERR_SOCKET_CLOSED',
  'ESOCKETTIMEDOUT',
  'ETIMEDOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_CLOSED',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_DESTROYED',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
]);

const TRANSIENT_NAMES = new Set([
  'AbortError',
  'BodyTimeoutError',
  'ClientClosedError',
  'ConnectTimeoutError',
  'HeadersTimeoutError',
  'SocketError',
  'TimeoutError',
]);

const TRANSIENT_MESSAGES = [
  /opening handshake has timed out/i,
  /websocket open timed out/i,
  /unable to connect to (?:wss?|https?):\/\//i,
  /fetch failed/i,
  /network socket disconnected/i,
  /the client is closed/i,
  /(?:app-server|websocket|socket|network|connection|connect|handshake|request|headers?|body|dns).{0,80}(?:timed out|timeout|reset|closed|refused|unreachable|unavailable|disconnected)/i,
  /(?:timed out|timeout|reset|closed|refused|unreachable|unavailable|disconnected).{0,80}(?:app-server|websocket|socket|network|connection|connect|handshake|request|headers?|body|dns)/i,
];

function relatedErrors(error) {
  const pending = [error];
  const values = [];
  const seen = new Set();
  while (pending.length > 0) {
    const value = pending.shift();
    if (!value || (typeof value !== 'object' && typeof value !== 'function') || seen.has(value)) continue;
    seen.add(value);
    values.push(value);
    if (value.cause) pending.push(value.cause);
    if (Array.isArray(value.errors)) pending.push(...value.errors);
  }
  return values;
}

export function isTransientCommunicationError(error) {
  return relatedErrors(error).some((value) => {
    const code = String(value.code ?? '').toLocaleUpperCase('en-US');
    if (TRANSIENT_CODES.has(code)) return true;
    if (TRANSIENT_NAMES.has(String(value.name ?? ''))) return true;
    const message = String(value.message ?? value);
    return TRANSIENT_MESSAGES.some((pattern) => pattern.test(message));
  });
}

