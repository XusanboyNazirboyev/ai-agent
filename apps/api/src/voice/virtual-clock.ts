import type { Clock } from './ports.js';

interface Timer {
  readonly at: number;
  readonly seq: number;
  readonly resolve: () => void;
}

/**
 * Deterministic clock for tests and the latency harness: sleep() never waits
 * in real time; runUntil() advances virtual time to the next timer whenever
 * all other work has gone idle.
 */
export class VirtualClock implements Clock {
  private current = 0;
  private seq = 0;
  private timers: Timer[] = [];

  now(): number {
    return this.current;
  }

  sleep(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.timers.push({ at: this.current + ms, seq: this.seq++, resolve });
    });
  }

  /** Drives the clock until `work` settles; throws if nothing can progress. */
  async runUntil<T>(work: Promise<T>): Promise<T> {
    let settled = false;
    void work.then(
      () => (settled = true),
      () => (settled = true),
    );
    for (;;) {
      await flushMicrotasks();
      if (settled) return work;
      const next = this.takeNext();
      if (!next) {
        throw new Error('VirtualClock deadlock: no timers and work pending');
      }
      this.current = Math.max(this.current, next.at);
      next.resolve();
    }
  }

  private takeNext(): Timer | undefined {
    if (this.timers.length === 0) return undefined;
    let best = 0;
    for (let i = 1; i < this.timers.length; i += 1) {
      const a = this.timers[i];
      const b = this.timers[best];
      if (a.at < b.at || (a.at === b.at && a.seq < b.seq)) best = i;
    }
    return this.timers.splice(best, 1)[0];
  }
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
