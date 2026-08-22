const CONTROLLER_NOTIFICATION_METHODS = new Set([
  'error',
  'guardianWarning',
  'item/agentMessage/delta',
  'item/completed',
  'item/reasoning/summaryPartAdded',
  'item/reasoning/summaryTextDelta',
  'item/reasoning/textDelta',
  'item/started',
  'serverRequest/resolved',
  'thread/archived',
  'thread/deleted',
  'thread/name/updated',
  'thread/settings/updated',
  'thread/started',
  'thread/status/changed',
  'thread/tokenUsage/updated',
  'thread/unarchived',
  'turn/completed',
  'turn/plan/updated',
  'turn/started',
  'warning',
]);

const COALESCIBLE_DELTA_METHODS = new Set([
  'item/agentMessage/delta',
  'item/reasoning/summaryTextDelta',
  'item/reasoning/textDelta',
]);

function sameIdentity(left, right, name) {
  return (left?.params?.[name] ?? null) === (right?.params?.[name] ?? null);
}

export function isControllerCodexNotification(message) {
  return CONTROLLER_NOTIFICATION_METHODS.has(message?.method);
}

export function isHighVolumeCodexNotification(message) {
  return String(message?.method ?? '').toLowerCase().endsWith('delta');
}

export function coalesceCodexNotification(left, right) {
  if (!left || !right || left.message.method !== right.message.method) return null;
  if (!COALESCIBLE_DELTA_METHODS.has(left.message.method)) return null;
  for (const name of [
    'threadId',
    'turnId',
    'itemId',
    'phase',
    'summaryIndex',
    'partIndex',
  ]) {
    if (!sameIdentity(left.message, right.message, name)) return null;
  }
  return {
    eventSequence: right.eventSequence,
    message: {
      ...left.message,
      params: {
        ...left.message.params,
        delta: `${left.message.params?.delta ?? ''}${right.message.params?.delta ?? ''}`,
      },
    },
  };
}
