export enum ConnectorErrorCategory {
  CONFIGURATION = 'CONFIGURATION',
  AUTHENTICATION = 'AUTHENTICATION',
  AUTHORIZATION = 'AUTHORIZATION',
  NOT_FOUND = 'NOT_FOUND',
  VALIDATION = 'VALIDATION',
  TIMEOUT = 'TIMEOUT',
  RATE_LIMITED = 'RATE_LIMITED',
  UNAVAILABLE = 'UNAVAILABLE',
  INVALID_RESPONSE = 'INVALID_RESPONSE',
  CAPABILITY = 'CAPABILITY',
  CANCELLED = 'CANCELLED',
  UNKNOWN = 'UNKNOWN',
}

export interface ConnectorErrorOptions {
  message: string;
  code: string;
  category: ConnectorErrorCategory;
  retryable?: boolean;
  source?: string;
  cause?: unknown;
  /** Upstream-requested delay (e.g. `Retry-After`) before a retry may run. */
  retryAfterMs?: number;
  /**
   * For writes: whether the remote side may have applied the operation.
   * `no` only when the connector can show it did not (rejected before or by
   * the remote). Absent = derived from the category (see writeExecutionOf).
   */
  executed?: 'no' | 'unknown';
}

/** Base error for all connector failures. Never includes credentials or raw customer payloads. */
export class ConnectorError extends Error {
  readonly code: string;
  readonly category: ConnectorErrorCategory;
  readonly retryable: boolean;
  readonly source: string | undefined;
  readonly retryAfterMs: number | undefined;
  readonly executed: 'no' | 'unknown' | undefined;

  constructor(options: ConnectorErrorOptions) {
    super(options.message);
    this.name = 'ConnectorError';
    this.code = options.code;
    this.category = options.category;
    this.retryable = options.retryable ?? false;
    this.source = options.source;
    this.retryAfterMs = options.retryAfterMs;
    this.executed = options.executed;
    if (options.cause instanceof Error) {
      this.cause = options.cause;
    }
  }
}

export class ConnectorConfigurationError extends ConnectorError {
  constructor(
    options: Omit<ConnectorErrorOptions, 'category' | 'code'> & {
      code?: string;
    },
  ) {
    super({
      message: options.message,
      code: options.code ?? 'CONNECTOR_CONFIGURATION_ERROR',
      category: ConnectorErrorCategory.CONFIGURATION,
      retryable: false,
      source: options.source,
      cause: options.cause,
      executed: options.executed,
    });
    this.name = 'ConnectorConfigurationError';
  }
}

export class ConnectorUnauthorizedError extends ConnectorError {
  constructor(
    options: Omit<ConnectorErrorOptions, 'category' | 'code'> & {
      code?: string;
    },
  ) {
    super({
      message: options.message,
      code: options.code ?? 'CONNECTOR_UNAUTHORIZED',
      category: ConnectorErrorCategory.AUTHENTICATION,
      retryable: false,
      source: options.source,
      cause: options.cause,
      executed: options.executed,
    });
    this.name = 'ConnectorUnauthorizedError';
  }
}

export class ConnectorNotFoundError extends ConnectorError {
  constructor(
    options: Omit<ConnectorErrorOptions, 'category' | 'code'> & {
      code?: string;
    },
  ) {
    super({
      message: options.message,
      code: options.code ?? 'CONNECTOR_NOT_FOUND',
      category: ConnectorErrorCategory.NOT_FOUND,
      retryable: false,
      source: options.source,
      cause: options.cause,
      executed: options.executed,
    });
    this.name = 'ConnectorNotFoundError';
  }
}

export class ConnectorTimeoutError extends ConnectorError {
  constructor(
    options: Omit<ConnectorErrorOptions, 'category' | 'code'> & {
      code?: string;
    },
  ) {
    super({
      message: options.message,
      code: options.code ?? 'CONNECTOR_TIMEOUT',
      category: ConnectorErrorCategory.TIMEOUT,
      retryable: true,
      source: options.source,
      cause: options.cause,
      executed: options.executed,
    });
    this.name = 'ConnectorTimeoutError';
  }
}

export class ConnectorUnavailableError extends ConnectorError {
  constructor(
    options: Omit<ConnectorErrorOptions, 'category' | 'code'> & {
      code?: string;
    },
  ) {
    super({
      message: options.message,
      code: options.code ?? 'CONNECTOR_UNAVAILABLE',
      category: ConnectorErrorCategory.UNAVAILABLE,
      // Defaults to retryable, but callers can opt out (e.g. redirect loops).
      retryable: options.retryable ?? true,
      source: options.source,
      cause: options.cause,
      retryAfterMs: options.retryAfterMs,
      executed: options.executed,
    });
    this.name = 'ConnectorUnavailableError';
  }
}

export class ConnectorInvalidResponseError extends ConnectorError {
  constructor(
    options: Omit<ConnectorErrorOptions, 'category' | 'code'> & {
      code?: string;
    },
  ) {
    super({
      message: options.message,
      code: options.code ?? 'CONNECTOR_INVALID_RESPONSE',
      category: ConnectorErrorCategory.INVALID_RESPONSE,
      retryable: false,
      source: options.source,
      cause: options.cause,
      executed: options.executed,
    });
    this.name = 'ConnectorInvalidResponseError';
  }
}

export class ConnectorCapabilityError extends ConnectorError {
  constructor(
    options: Omit<ConnectorErrorOptions, 'category' | 'code'> & {
      code?: string;
    },
  ) {
    super({
      message: options.message,
      code: options.code ?? 'CONNECTOR_CAPABILITY_ERROR',
      category: ConnectorErrorCategory.CAPABILITY,
      retryable: false,
      source: options.source,
      cause: options.cause,
      executed: options.executed,
    });
    this.name = 'ConnectorCapabilityError';
  }
}

export function isConnectorError(error: unknown): error is ConnectorError {
  return error instanceof ConnectorError;
}

export function connectorErrorCategory(error: unknown): ConnectorErrorCategory {
  return isConnectorError(error)
    ? error.category
    : ConnectorErrorCategory.UNKNOWN;
}

export function isRetryableConnectorError(error: unknown): boolean {
  return isConnectorError(error) && error.retryable;
}

/** Categories whose failure means the remote side did not apply a write. */
const NOT_EXECUTED_CATEGORIES: ReadonlySet<ConnectorErrorCategory> = new Set([
  ConnectorErrorCategory.CONFIGURATION,
  ConnectorErrorCategory.AUTHENTICATION,
  ConnectorErrorCategory.AUTHORIZATION,
  ConnectorErrorCategory.VALIDATION,
  ConnectorErrorCategory.CAPABILITY,
  ConnectorErrorCategory.RATE_LIMITED,
]);

/**
 * Execution outcome of a failed write. `NOT_EXECUTED` is claimed only when
 * the failure proves the remote side did not apply it (local validation,
 * configuration, an explicit 4xx rejection); timeouts, lost connections,
 * 5xx, unreadable responses and unknown errors are `UNCERTAIN`.
 */
export function writeExecutionOf(error: unknown): 'NOT_EXECUTED' | 'UNCERTAIN' {
  if (!isConnectorError(error)) return 'UNCERTAIN';
  if (error.executed === 'no') return 'NOT_EXECUTED';
  if (error.executed === 'unknown') return 'UNCERTAIN';
  return NOT_EXECUTED_CATEGORIES.has(error.category)
    ? 'NOT_EXECUTED'
    : 'UNCERTAIN';
}
