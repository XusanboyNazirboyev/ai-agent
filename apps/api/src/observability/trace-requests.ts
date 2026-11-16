import type { IncomingMessage, ServerResponse } from 'node:http';
import { runWithTenantSlot } from '../persistence/tenant-context.js';
import {
  newTraceId,
  runWithLogContext,
  TRACE_ID_FORMAT,
} from './log-context.js';

export const TRACE_HEADER = 'x-request-id';

/** The caller's `x-request-id` when it is one plausible id; otherwise a new one. */
export function traceIdFrom(header: string | string[] | undefined): string {
  return typeof header === 'string' && TRACE_ID_FORMAT.test(header)
    ? header
    : newTraceId();
}

/**
 * Express middleware: every HTTP request runs in its own log context and
 * answers with the id it used, so a client report can be matched to the
 * log lines.
 */
export function traceRequests(
  request: IncomingMessage,
  response: ServerResponse,
  next: () => void,
): void {
  const traceId = traceIdFrom(request.headers[TRACE_HEADER]);
  response.setHeader(TRACE_HEADER, traceId);
  // An empty tenant slot per request; the session check fills it (RLS plan).
  runWithLogContext({ traceId }, () => runWithTenantSlot(next));
}
