import test from 'node:test';
import assert from 'node:assert/strict';
import { codexRetryStatusText, isTransientCommunicationError } from '../src/communication-error.mjs';

test('classifies transient failures across every Bridge communication transport', () => {
  const gatewayHandshake = new Error('Opening handshake has timed out');
  const discordRest = Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' });
  const appServer = new Error('Codex app-server disconnected (1006).');
  const attachmentFetch = new TypeError('fetch failed', {
    cause: Object.assign(new Error('socket reset'), { code: 'ECONNRESET' }),
  });
  const dnsAggregate = new AggregateError([
    Object.assign(new Error('DNS retry'), { code: 'EAI_AGAIN' }),
  ]);
  const undiciTimeout = Object.assign(new Error('headers timeout'), {
    code: 'UND_ERR_HEADERS_TIMEOUT',
  });

  for (const error of [
    gatewayHandshake,
    discordRest,
    appServer,
    attachmentFetch,
    dnsAggregate,
    undiciTimeout,
  ]) {
    assert.equal(isTransientCommunicationError(error), true, error.message);
  }
});

test('does not hide authentication, certificate, configuration, or programming errors', () => {
  const invalidToken = new Error('Discord login failed: invalid token');
  const certificate = Object.assign(new Error('certificate mismatch'), {
    code: 'ERR_TLS_CERT_ALTNAME_INVALID',
  });
  const programmingError = new TypeError('Cannot read properties of undefined');
  const invalidUrl = new Error('Invalid WebSocket URL');

  for (const error of [invalidToken, certificate, programmingError, invalidUrl]) {
    assert.equal(isTransientCommunicationError(error), false, error.message);
  }
});

test('formats Codex retry notifications without exposing raw error details', () => {
  const params = {
    error: {
      message: 'Reconnecting... 3/5',
      codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } },
      additionalDetails: 'request ID must not be rendered',
    },
    willRetry: true,
    threadId: 'thread-1',
    turnId: 'turn-1',
  };

  assert.equal(codexRetryStatusText(params), '通信エラーです。再試行中（3/5）');
  assert.equal(codexRetryStatusText({ error: { message: 'temporary failure' }, willRetry: true }), '通信エラーです。再試行中です。');
  assert.equal(codexRetryStatusText({ error: { message: 'permanent failure' }, willRetry: false }), null);
});
