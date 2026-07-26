export const RECENT_HISTORY_DAY_OPTIONS = Object.freeze([1, 3, 7]);
export const MAX_RECENT_HISTORY_DAYS = RECENT_HISTORY_DAY_OPTIONS.at(-1);

export function recentHistoryCutoffMs(days, nowMs = Date.now()) {
  if (!RECENT_HISTORY_DAY_OPTIONS.includes(days)) {
    throw new Error(`履歴復元の日数は ${RECENT_HISTORY_DAY_OPTIONS.join('、')} 日から選択してください。`);
  }
  return nowMs - days * 24 * 60 * 60 * 1000;
}

export function epochMilliseconds(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = typeof value === 'number' ? value : Number(value);
  if (Number.isFinite(numeric)) {
    return Math.abs(numeric) < 1_000_000_000_000 ? numeric * 1000 : numeric;
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

export function uuidV7TimestampMs(value) {
  const match = String(value ?? '').match(/^([0-9a-f]{8})-([0-9a-f]{4})-[7][0-9a-f]{3}-/i);
  if (!match) return null;
  const timestamp = Number.parseInt(`${match[1]}${match[2]}`, 16);
  return Number.isSafeInteger(timestamp) ? timestamp : null;
}

export function turnTimestampMs(turn) {
  for (const value of [turn?.completedAt, turn?.startedAt, turn?.updatedAt, turn?.createdAt]) {
    const timestamp = epochMilliseconds(value);
    if (timestamp !== null) return timestamp;
  }
  return uuidV7TimestampMs(turn?.id);
}

export function completedTurnsSince(turns, cutoffMs) {
  return (turns ?? []).filter((turn) => (
    turn.status !== 'inProgress'
    && (turnTimestampMs(turn) ?? Number.NEGATIVE_INFINITY) >= cutoffMs
  ));
}

export function historicalAssistantItems(turn) {
  const result = [];
  for (const item of turn?.items ?? []) {
    if (item.type === 'agentMessage' && item.phase === 'commentary' && item.text && item.id) {
      result.push(item);
      continue;
    }
    if (item.type !== 'reasoning' || !item.id) continue;
    const text = [...new Set((item.summary ?? [])
      .map((value) => String(value).trim())
      .filter(Boolean))]
      .join('\n');
    if (text) result.push({
      type: 'reasoning',
      id: item.id,
      phase: 'reasoning',
      text,
    });
  }
  return result;
}
