import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

/**
 * Correlation fields added to every log line written while a request, queue
 * job or scheduled scan runs (spec Section 11: traceId, conversationId,
 * tenantId, language). Identifiers only: never customer or CRM text.
 */
export interface LogContext {
  readonly traceId: string;
  tenantId?: string;
  conversationId?: string;
  language?: string;
}

type Enrichment = Partial<Omit<LogContext, 'traceId'>>;

const storage = new AsyncLocalStorage<LogContext>();

/** A trace id from outside (e.g. `x-request-id`) is used only in this shape. */
export const TRACE_ID_FORMAT = /^[A-Za-z0-9._:-]{8,128}$/u;

export function newTraceId(): string {
  return randomUUID();
}

/** Runs `work` with its own context; nested runs get their own copy. */
export function runWithLogContext<T>(context: LogContext, work: () => T): T {
  return storage.run({ ...context }, work);
}

export function currentLogContext(): Readonly<LogContext> | undefined {
  return storage.getStore();
}

/**
 * Adds what becomes known later (the tenant after the session check, the
 * conversation once a job has resolved it). Outside a context it does nothing.
 */
export function enrichLogContext(fields: Enrichment): void {
  const context = storage.getStore();
  if (!context) return;
  for (const [key, value] of Object.entries(fields) as [
    keyof Enrichment,
    string | undefined,
  ][]) {
    if (value !== undefined) context[key] = value;
  }
}
