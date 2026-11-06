import { isTransientCommunicationError } from './communication-error.mjs';
import { DeliveryOutboxLockedError } from './delivery-outbox.mjs';

class DeliveryLane {
  #nextReason = null;

  constructor(run, isStopping, onError) {
    this.run = run;
    this.isStopping = isStopping;
    this.onError = onError;
    this.pending = null;
  }

  kick(reason) {
    if (this.isStopping()) return Promise.resolve();
    this.#nextReason = reason;
    if (!this.pending) this.pending = this.#run();
    return this.pending;
  }

  async #run() {
    // Set pending before the first pass. An arrival during a pass requests
    // another pass, including when the first pass already took its snapshot.
    await Promise.resolve();
    try {
      while (this.#nextReason !== null && !this.isStopping()) {
        const reason = this.#nextReason;
        this.#nextReason = null;
        try { await this.run(reason); }
        catch (error) { this.onError(reason, error); }
      }
    } finally {
      this.pending = null;
    }
  }
}

export class DeliveryOutboxWorker {
  #delivery;
  #feedback;

  constructor({ outbox, codex, staleReason, present, isStopping, log }) {
    Object.assign(this, { outbox, codex, staleReason, present, isStopping, log });
    const lane = (run, errorEvent) => new DeliveryLane(run, isStopping, (reason, error) => {
      log(errorEvent, { reason, error: error.stack ?? error.message });
    });
    this.#delivery = lane((reason) => this.#deliver(reason), 'delivery-outbox-drain-error');
    this.#feedback = lane((reason) => this.#present(reason), 'delivery-outbox-feedback-error');
  }

  pendingWork() {
    return [
      ['delivery-outbox', this.#delivery.pending],
      ['delivery-outbox-feedback', this.#feedback.pending],
    ];
  }

  request(reason) {
    const delivery = this.#canDeliver() ? this.#delivery.kick(reason) : Promise.resolve();
    this.#feedback.kick(reason);
    return delivery;
  }

  #canDeliver() {
    return !this.isStopping() && this.codex.connected && !this.codex.subscriptionRestoreInProgress;
  }

  #rejectStale(entry, reason) {
    const staleReason = this.staleReason(entry);
    if (!staleReason) return false;
    this.outbox.reject(entry.requestId, { error: staleReason, code: 'STALE_DELIVERY_TARGET' });
    this.#feedback.kick(reason);
    return true;
  }

  async #deliver(reason) {
    this.log('delivery-outbox-drain-start', { reason });
    const waitingThreads = new Set();
    for (const entry of this.outbox.listWork({ states: ['queued'] })) {
      if (!this.#canDeliver()) break;
      if (waitingThreads.has(entry.threadId)) continue;
      if (this.#rejectStale(entry, reason)) continue;

      let target;
      try {
        target = await this.codex.prepareDelivery(entry.threadId);
      } catch (error) {
        if (error.code === 'DESKTOP_THREAD_PENDING') {
          waitingThreads.add(entry.threadId);
          continue;
        }
        if (!this.codex.connected || isTransientCommunicationError(error)) {
          this.log('delivery-outbox-prepare-deferred', {
            requestId: entry.requestId,
            threadId: entry.threadId,
            error: error.message,
          });
          break;
        }
        this.outbox.reject(entry.requestId, {
          error,
          code: 'DELIVERY_TARGET_READ_REJECTED',
        });
        this.#feedback.kick(reason);
        continue;
      }

      if (!this.#canDeliver()) break;
      if (this.#rejectStale(entry, reason)) continue;
      let attempt;
      try {
        attempt = this.outbox.beginAttempt(entry.requestId, target);
      } catch (error) {
        if (error instanceof DeliveryOutboxLockedError) continue;
        throw error;
      }
      try {
        const result = await this.codex.executePreparedDelivery(
          entry.threadId,
          entry.prompt,
          entry.attachments,
          entry.requestId,
          target,
        );
        this.outbox.accept(entry.requestId, {
          attemptId: attempt.attempt.attemptId,
          mode: result.mode,
          turnId: result.turnId,
        });
        this.log('delivery-outbox-accepted', {
          requestId: entry.requestId,
          threadId: entry.threadId,
          mode: result.mode,
          turnId: result.turnId,
        });
      } catch (error) {
        this.outbox.markUncertain(entry.requestId, {
          attemptId: attempt.attempt.attemptId,
          error,
        });
        this.log('delivery-outbox-acceptance-uncertain', {
          requestId: entry.requestId,
          threadId: entry.threadId,
          error: error.stack ?? error.message,
        });
      } finally {
        this.#feedback.kick(reason);
      }
    }
    this.log('delivery-outbox-drain-complete', { reason, ...this.outbox.workSummary() });
  }

  async #present(reason) {
    for (const entry of this.outbox.listWork({ states: ['uncertain'] })) {
      if (!this.#canDeliver()) break;
      let receipt = null;
      try {
        receipt = await this.codex.findDeliveryReceipt(entry.threadId, entry.requestId, { limit: 20 });
      } catch (error) {
        this.log('delivery-outbox-reconcile-error', {
          requestId: entry.requestId,
          threadId: entry.threadId,
          error: error.stack ?? error.message,
        });
        break;
      }
      if (receipt?.turnId) {
        this.outbox.acceptReconciled(entry.requestId, {
          turnId: receipt.turnId,
          mode: entry.attempt?.mode ?? null,
        });
        this.log('delivery-outbox-reconciled', {
          requestId: entry.requestId,
          threadId: entry.threadId,
          turnId: receipt.turnId,
        });
      } else {
        this.log('delivery-outbox-remains-uncertain', {
          requestId: entry.requestId,
          threadId: entry.threadId,
        });
      }
    }

    for (const entry of this.outbox.listWork({
      states: ['accepted', 'rejected', 'uncertain'],
      callbackStates: ['pending'],
    })) {
      if (this.isStopping()) break;
      try { await this.present(entry); }
      catch (error) {
        this.log('delivery-outbox-feedback-error', {
          reason, requestId: entry.requestId, error: error.stack ?? error.message,
        });
      }
    }
  }
}
