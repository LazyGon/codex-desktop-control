import { isTransientCommunicationError } from './communication-error.mjs';

export const DEFAULT_GATEWAY_RECYCLE_AFTER_MS = 300_000;
export const DEFAULT_GATEWAY_ERROR_GAP_MS = 30_000;
export const DEFAULT_GATEWAY_LOG_INTERVAL_MS = 60_000;
export const DEFAULT_GATEWAY_MIN_ERRORS = 30;

function isoTime(value) {
  return Number.isFinite(value) ? new Date(value).toISOString() : null;
}

export class DiscordGatewayHealth {
  constructor({
    recycleAfterMs = DEFAULT_GATEWAY_RECYCLE_AFTER_MS,
    continuousErrorGapMs = DEFAULT_GATEWAY_ERROR_GAP_MS,
    logIntervalMs = DEFAULT_GATEWAY_LOG_INTERVAL_MS,
    minimumErrors = DEFAULT_GATEWAY_MIN_ERRORS,
  } = {}) {
    if (!Number.isInteger(recycleAfterMs) || recycleAfterMs < DEFAULT_GATEWAY_RECYCLE_AFTER_MS) {
      throw new Error(`Gateway recycle timeout must be at least ${DEFAULT_GATEWAY_RECYCLE_AFTER_MS}ms.`);
    }
    if (!Number.isInteger(continuousErrorGapMs) || continuousErrorGapMs <= 0) {
      throw new Error('Gateway continuous-error gap must be a positive integer.');
    }
    if (!Number.isInteger(logIntervalMs) || logIntervalMs <= 0) {
      throw new Error('Gateway error log interval must be a positive integer.');
    }
    if (!Number.isInteger(minimumErrors) || minimumErrors <= 0) {
      throw new Error('Gateway minimum error count must be a positive integer.');
    }
    this.recycleAfterMs = recycleAfterMs;
    this.continuousErrorGapMs = continuousErrorGapMs;
    this.logIntervalMs = logIntervalMs;
    this.minimumErrors = minimumErrors;
    this.state = 'starting';
    this.readyAt = null;
    this.firstErrorAt = null;
    this.lastErrorAt = null;
    this.lastLogAt = null;
    this.errorCount = 0;
    this.loggedErrorCount = 0;
    this.recycleIssued = false;
    this.shardId = null;
    this.lastError = null;
  }

  markReconnecting({ at = Date.now(), shardId = null } = {}) {
    if (this.state !== 'recycling') this.state = 'reconnecting';
    this.readyAt = null;
    this.shardId = shardId;
    return this.snapshot(at);
  }

  markReady({ at = Date.now(), shardId = null } = {}) {
    const recovery = this.errorCount > 0 || ['failed', 'reconnecting', 'recycling'].includes(this.state)
      ? {
          errorCount: this.errorCount,
          durationMs: this.firstErrorAt == null ? null : Math.max(0, at - this.firstErrorAt),
          firstErrorAt: isoTime(this.firstErrorAt),
          lastErrorAt: isoTime(this.lastErrorAt),
        }
      : null;
    this.state = 'ready';
    this.readyAt = at;
    this.firstErrorAt = null;
    this.lastErrorAt = null;
    this.lastLogAt = null;
    this.errorCount = 0;
    this.loggedErrorCount = 0;
    this.recycleIssued = false;
    this.shardId = shardId;
    this.lastError = null;
    return { recovery, snapshot: this.snapshot(at) };
  }

  recordError(error, { at = Date.now(), shardId = null } = {}) {
    const transient = isTransientCommunicationError(error);
    if (!transient) {
      this.state = 'failed';
      this.readyAt = null;
      this.lastErrorAt = at;
      this.shardId = shardId;
      this.lastError = String(error?.message ?? error);
      return {
        tracked: false,
        shouldLog: true,
        shouldRecycle: false,
        suppressedErrors: 0,
        snapshot: this.snapshot(at),
      };
    }
    if (this.lastErrorAt == null || at - this.lastErrorAt > this.continuousErrorGapMs) {
      this.firstErrorAt = at;
      this.errorCount = 0;
      this.loggedErrorCount = 0;
      this.lastLogAt = null;
      this.recycleIssued = false;
    }
    this.state = 'reconnecting';
    this.readyAt = null;
    this.lastErrorAt = at;
    this.errorCount += 1;
    this.shardId = shardId;
    this.lastError = String(error?.message ?? error);
    const shouldLog = this.lastLogAt == null || at - this.lastLogAt >= this.logIntervalMs;
    const suppressedErrors = shouldLog ? Math.max(0, this.errorCount - this.loggedErrorCount - 1) : 0;
    if (shouldLog) {
      this.lastLogAt = at;
      this.loggedErrorCount = this.errorCount;
    }
    const shouldRecycle = !this.recycleIssued
      && this.errorCount >= this.minimumErrors
      && at - this.firstErrorAt >= this.recycleAfterMs;
    if (shouldRecycle) {
      this.recycleIssued = true;
      this.state = 'recycling';
    }
    return {
      tracked: true,
      shouldLog,
      shouldRecycle,
      suppressedErrors,
      snapshot: this.snapshot(at),
    };
  }

  snapshot(at = Date.now()) {
    return {
      state: this.state,
      ready: this.state === 'ready',
      readyAt: isoTime(this.readyAt),
      shardId: this.shardId,
      errorCount: this.errorCount,
      firstErrorAt: isoTime(this.firstErrorAt),
      lastErrorAt: isoTime(this.lastErrorAt),
      lastError: this.lastError,
      recycleDueAt: this.firstErrorAt == null || this.recycleIssued
        ? null
        : isoTime(this.firstErrorAt + this.recycleAfterMs),
      recycleIssued: this.recycleIssued,
    };
  }
}
