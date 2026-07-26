export class LatestUpdateQueue {
  constructor({ apply, equals = (left, right) => left === right, onError = () => {} }) {
    this.apply = apply;
    this.equals = equals;
    this.onError = onError;
    this.pending = new Map();
  }

  schedule(key, value) {
    const existing = this.pending.get(key);
    if (existing) {
      if (!this.equals(existing.current, value)
        && (!existing.latest || !this.equals(existing.latest, value))) {
        existing.latest = value;
      }
      return false;
    }

    const entry = { current: value, latest: null };
    this.pending.set(key, entry);
    this.#drain(key, entry);
    return true;
  }

  async #drain(key, entry) {
    while (entry.current) {
      try {
        await this.apply(entry.current);
      } catch (error) {
        this.onError(error, entry.current);
      }
      entry.current = entry.latest;
      entry.latest = null;
    }
    if (this.pending.get(key) === entry) this.pending.delete(key);
  }
}
