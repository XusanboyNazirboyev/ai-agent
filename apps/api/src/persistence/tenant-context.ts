import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * ADR 054 (S0 spike): the tenant a unit of work runs for. Read by the Prisma
 * RLS extension (`rls-extension.ts`) to set `app.tenant_id` transaction-locally.
 */
export interface TenantStore {
  readonly tenantId?: string;
  /** Explicit cross-tenant path (allow-listed code); the extension passes through. */
  readonly system?: boolean;
  /** Set by the extension inside a transaction it already opened: do not wrap again. */
  readonly inTransaction?: boolean;
}

const storage = new AsyncLocalStorage<TenantStore>();

/**
 * A Prisma call is a lazy PrismaPromise: it executes when `.then` is called,
 * not when the call is written. `runWithTenant(id, () => prisma.x.findMany())`
 * returns that promise to the caller, who awaits it OUTSIDE this scope, so the
 * hook would see no context. Thenable results are therefore awaited inside the
 * scope (found by the S0 spike).
 */
function runScoped<T>(store: TenantStore, fn: () => T): T {
  return storage.run(store, () => {
    const result = fn();
    if (
      result !== null &&
      typeof result === 'object' &&
      typeof (result as { then?: unknown }).then === 'function'
    )
      return (async (): Promise<unknown> => await result)() as T;
    return result;
  });
}

export function runWithTenant<T>(tenantId: string, fn: () => T): T {
  if (!tenantId) throw new Error('runWithTenant requires a tenant id');
  return runScoped({ tenantId }, fn);
}

export function runAsSystem<T>(fn: () => T): T {
  return runScoped({ system: true }, fn);
}

/** Internal: marks the current async scope as already inside a tenant-set transaction. */
export function runInTransaction<T>(fn: () => T): T {
  return runScoped({ ...storage.getStore(), inTransaction: true }, fn);
}

export function currentTenant(): string | undefined {
  return storage.getStore()?.tenantId;
}

export function currentStore(): TenantStore | undefined {
  return storage.getStore();
}
