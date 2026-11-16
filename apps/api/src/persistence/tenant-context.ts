import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * The tenant a piece of work runs for (ADR 050, RLS enforcement plan S1). It
 * travels with the async call chain, so the database adapter can give
 * PostgreSQL the same tenant (`app.tenant_id`) without every query passing it.
 *
 * A slot holds at most one tenant: once set it cannot change, so a request or
 * job can never switch to another workspace half way.
 */
interface Slot {
  tenantId: string | null;
}

const storage = new AsyncLocalStorage<Slot>();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export class TenantContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TenantContextError';
  }
}

function checked(tenantId: string): string {
  if (!UUID.test(tenantId))
    throw new TenantContextError('Tenant id is not a UUID');
  return tenantId.toLowerCase();
}

/**
 * Starts a lazy promise inside the context. Prisma's queries are thenables
 * that run only when `.then` is called; returned unstarted, they would run
 * later, outside the context, when the caller awaits them.
 */
function started<T>(result: T): T {
  const thenable = result as { then?: unknown } | null | undefined;
  if (thenable && typeof thenable.then === 'function')
    return (result as unknown as PromiseLike<unknown>).then(
      (value) => value,
    ) as unknown as T;
  return result;
}

/** Runs `fn` for one tenant. Nested runs must name the same tenant. */
export function runWithTenant<T>(tenantId: string, fn: () => T): T {
  const id = checked(tenantId);
  const current = storage.getStore()?.tenantId;
  if (current && current !== id)
    throw new TenantContextError('Another tenant is already set');
  return storage.run({ tenantId: id }, () => started(fn()));
}

/** Opens an empty slot (an HTTP request before its session is known). */
export function runWithTenantSlot<T>(fn: () => T): T {
  return storage.run({ tenantId: null }, () => started(fn()));
}

/**
 * Fills the open slot once the tenant is known (after the session check).
 * Without a slot it does nothing; a different tenant than the one set throws.
 */
export function setTenant(tenantId: string): void {
  const slot = storage.getStore();
  if (!slot) return;
  const id = checked(tenantId);
  if (slot.tenantId && slot.tenantId !== id)
    throw new TenantContextError('Another tenant is already set');
  slot.tenantId = id;
}

/** Work that belongs to no tenant (shared timers, cross-tenant scans). */
export function runWithoutTenant<T>(fn: () => T): T {
  return storage.exit(() => started(fn()));
}

export function currentTenant(): string | null {
  return storage.getStore()?.tenantId ?? null;
}
