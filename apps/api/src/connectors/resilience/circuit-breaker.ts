export enum CircuitState {
  CLOSED = 'CLOSED',
  OPEN = 'OPEN',
  HALF_OPEN = 'HALF_OPEN',
}

export interface CircuitBreakerOptions {
  readonly name: string;
  readonly source?: string;
  readonly failureThreshold: number; // consecutive failures to open
  readonly recoveryIntervalMs: number; // before trying half-open
  readonly halfOpenMaxAttempts: number; // trial successes before closing
  readonly onStateChange?: (from: CircuitState, to: CircuitState) => void;
  /**
   * Whether an error says the upstream is unhealthy. Errors that prove the
   * upstream answered (not found, validation, auth) count as successes for
   * health purposes. Defaults to treating every error as a failure.
   */
  readonly isFailure?: (error: unknown) => boolean;
  readonly now?: () => number;
}

export interface CircuitBreakerSnapshot {
  readonly name: string;
  readonly state: CircuitState;
  readonly failures: number;
  readonly successes: number;
  readonly openedAt: number | undefined;
}

export class CircuitBreakerError extends Error {
  constructor(
    public readonly name: string,
    public readonly source?: string,
  ) {
    super(`Circuit breaker '${name}' is open`);
    this.name = 'CircuitBreakerError';
  }
}

/**
 * Simple, testable circuit breaker with closed / open / half-open states.
 *
 * State is held per instance. For per-tenant isolation, create one breaker per
 * connector+tenant combination rather than a shared singleton.
 */
export class CircuitBreaker {
  private state = CircuitState.CLOSED;
  private failures = 0;
  private successes = 0;
  private trialsInFlight = 0;
  private openedAt: number | undefined;
  private readonly options: CircuitBreakerOptions;
  private readonly isFailure: (error: unknown) => boolean;
  private readonly now: () => number;

  constructor(options: CircuitBreakerOptions) {
    this.options = options;
    this.isFailure = options.isFailure ?? ((): boolean => true);
    this.now = options.now ?? Date.now;
    if (this.options.failureThreshold < 1) {
      throw new Error('failureThreshold must be >= 1');
    }
    if (this.options.recoveryIntervalMs < 0) {
      throw new Error('recoveryIntervalMs must be >= 0');
    }
    if (this.options.halfOpenMaxAttempts < 1) {
      throw new Error('halfOpenMaxAttempts must be >= 1');
    }
  }

  get snapshot(): CircuitBreakerSnapshot {
    return {
      name: this.options.name,
      state: this.state,
      failures: this.failures,
      successes: this.successes,
      openedAt: this.openedAt,
    };
  }

  private transition(to: CircuitState): void {
    const from = this.state;
    if (from === to) return;
    this.state = to;
    if (to === CircuitState.OPEN) {
      this.openedAt = this.now();
      this.failures = 0;
      this.successes = 0;
    } else if (to === CircuitState.CLOSED) {
      this.openedAt = undefined;
      this.failures = 0;
      this.successes = 0;
    } else if (to === CircuitState.HALF_OPEN) {
      this.successes = 0;
    }
    this.options.onStateChange?.(from, to);
  }

  private recordFailure(): void {
    this.failures++;
    if (this.state === CircuitState.HALF_OPEN) {
      this.transition(CircuitState.OPEN);
      return;
    }
    if (
      this.state === CircuitState.CLOSED &&
      this.failures >= this.options.failureThreshold
    ) {
      this.transition(CircuitState.OPEN);
    }
  }

  private recordSuccess(): void {
    if (this.state === CircuitState.CLOSED) {
      // The threshold counts *consecutive* failures.
      this.failures = 0;
      return;
    }
    if (this.state === CircuitState.HALF_OPEN) {
      this.successes++;
      if (this.successes >= this.options.halfOpenMaxAttempts) {
        this.transition(CircuitState.CLOSED);
      }
    }
  }

  /**
   * Execute `fn` if the breaker allows it. On success the breaker records a
   * success; on failure it records a failure and may open. Throws
   * CircuitBreakerError while open, and while half-open once the permitted
   * number of trial calls is already in flight.
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === CircuitState.OPEN) {
      if (
        this.openedAt !== undefined &&
        this.now() - this.openedAt >= this.options.recoveryIntervalMs
      ) {
        this.transition(CircuitState.HALF_OPEN);
      } else {
        throw new CircuitBreakerError(this.options.name, this.options.source);
      }
    }

    const trial = this.state === CircuitState.HALF_OPEN;
    if (trial) {
      if (this.trialsInFlight >= this.options.halfOpenMaxAttempts) {
        throw new CircuitBreakerError(this.options.name, this.options.source);
      }
      this.trialsInFlight++;
    }

    try {
      const result = await fn();
      this.recordSuccess();
      return result;
    } catch (error) {
      if (this.isFailure(error)) {
        this.recordFailure();
      } else {
        this.recordSuccess();
      }
      throw error;
    } finally {
      if (trial) this.trialsInFlight--;
    }
  }
}
