import { describe, expect, it, vi } from 'vitest';
import {
  ConnectorConfigurationError,
  ConnectorUnavailableError,
} from '../interfaces/errors.js';
import {
  CircuitBreaker,
  CircuitBreakerError,
  CircuitState,
} from './circuit-breaker.js';
import { backoffDelayMs, retryWithBackoff } from './retry.js';

const transient = (): ConnectorUnavailableError =>
  new ConnectorUnavailableError({ message: 'fictional outage' });

describe('CircuitBreaker', () => {
  function breaker(
    overrides: Partial<ConstructorParameters<typeof CircuitBreaker>[0]> = {},
  ): { breaker: CircuitBreaker; advance: (ms: number) => void } {
    let now = 0;
    return {
      breaker: new CircuitBreaker({
        name: 'tenant-a:test',
        failureThreshold: 2,
        recoveryIntervalMs: 1_000,
        halfOpenMaxAttempts: 1,
        now: () => now,
        ...overrides,
      }),
      advance: (ms): void => {
        now += ms;
      },
    };
  }

  it('opens after consecutive failures and fails fast while open', async () => {
    const { breaker: subject } = breaker();
    const failing = vi.fn(async () => {
      throw transient();
    });
    await expect(subject.execute(failing)).rejects.toThrow();
    await expect(subject.execute(failing)).rejects.toThrow();
    await expect(subject.execute(failing)).rejects.toBeInstanceOf(
      CircuitBreakerError,
    );
    expect(failing).toHaveBeenCalledTimes(2);
    expect(subject.snapshot.state).toBe(CircuitState.OPEN);
  });

  it('counts only consecutive failures', async () => {
    const { breaker: subject } = breaker();
    await expect(
      subject.execute(async () => Promise.reject(transient())),
    ).rejects.toThrow();
    await subject.execute(async () => 'ok');
    await expect(
      subject.execute(async () => Promise.reject(transient())),
    ).rejects.toThrow();
    expect(subject.snapshot.state).toBe(CircuitState.CLOSED);
  });

  it('ignores errors that prove the upstream answered', async () => {
    const { breaker: subject } = breaker({
      isFailure: (error) => error instanceof ConnectorUnavailableError,
    });
    for (let attempt = 0; attempt < 5; attempt++) {
      await expect(
        subject.execute(async () => {
          throw new ConnectorConfigurationError({ message: 'not found' });
        }),
      ).rejects.toThrow();
    }
    expect(subject.snapshot.state).toBe(CircuitState.CLOSED);
  });

  it('allows a single half-open trial and closes on success', async () => {
    const { breaker: subject, advance } = breaker();
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(
        subject.execute(async () => Promise.reject(transient())),
      ).rejects.toThrow();
    }
    advance(1_000);

    let release!: () => void;
    const trial = subject.execute(
      () =>
        new Promise<string>((resolve) => {
          release = (): void => resolve('ok');
        }),
    );
    await expect(
      subject.execute(async () => 'concurrent'),
    ).rejects.toBeInstanceOf(CircuitBreakerError);
    release();
    await expect(trial).resolves.toBe('ok');
    expect(subject.snapshot.state).toBe(CircuitState.CLOSED);
  });

  it('re-opens when the half-open trial fails', async () => {
    const { breaker: subject, advance } = breaker();
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(
        subject.execute(async () => Promise.reject(transient())),
      ).rejects.toThrow();
    }
    advance(1_000);
    await expect(
      subject.execute(async () => Promise.reject(transient())),
    ).rejects.toThrow();
    expect(subject.snapshot.state).toBe(CircuitState.OPEN);
  });
});

describe('retryWithBackoff', () => {
  const sleep = vi.fn(async () => undefined);

  it('retries retryable errors up to the attempt limit', async () => {
    const fn = vi.fn(async () => {
      throw transient();
    });
    await expect(
      retryWithBackoff(fn, { attempts: 3, baseMs: 10, maxMs: 100, sleep }),
    ).rejects.toMatchObject({ code: 'CONNECTOR_UNAVAILABLE' });
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('throws permanent errors immediately', async () => {
    const fn = vi.fn(async () => {
      throw new ConnectorConfigurationError({ message: 'bad config' });
    });
    await expect(
      retryWithBackoff(fn, { attempts: 3, baseMs: 10, maxMs: 100, sleep }),
    ).rejects.toThrow('bad config');
    expect(fn).toHaveBeenCalledOnce();
  });

  it('waits at least the upstream Retry-After', async () => {
    sleep.mockClear();
    let calls = 0;
    await retryWithBackoff(
      async () => {
        if (calls++ === 0) {
          throw new ConnectorUnavailableError({
            message: 'rate limited',
            retryAfterMs: 750,
          });
        }
        return 'ok';
      },
      { attempts: 2, baseMs: 10, maxMs: 1_000, sleep },
    );
    expect(sleep).toHaveBeenCalledWith(750);
  });

  it('gives up rather than retrying early when Retry-After exceeds the cap', async () => {
    const fn = vi.fn(async () => {
      throw new ConnectorUnavailableError({
        message: 'rate limited',
        retryAfterMs: 60_000,
      });
    });
    await expect(
      retryWithBackoff(fn, { attempts: 3, baseMs: 10, maxMs: 1_000, sleep }),
    ).rejects.toMatchObject({ retryAfterMs: 60_000 });
    expect(fn).toHaveBeenCalledOnce();
  });

  it('bounds the backoff delay', () => {
    expect(backoffDelayMs(0, { baseMs: 100, maxMs: 1_000 })).toBe(100);
    expect(backoffDelayMs(10, { baseMs: 100, maxMs: 1_000 })).toBe(1_000);
  });
});
