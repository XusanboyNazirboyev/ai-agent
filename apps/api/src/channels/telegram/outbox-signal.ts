/**
 * Wakes the outbox relay as soon as a row is committed, instead of waiting up
 * to its 500 ms poll (owner 2026-11-21: the agent is too slow). One process
 * runs the webhook, the worker and the relay (deploy/docker-compose.prod.yml);
 * the poll stays as the safety net, so a missed signal only costs the wait.
 */
const listeners = new Set<() => void>();

export function onOutboxWritten(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Call after the transaction that wrote an outbox row has committed. */
export function outboxWritten(): void {
  for (const listener of listeners) listener();
}
