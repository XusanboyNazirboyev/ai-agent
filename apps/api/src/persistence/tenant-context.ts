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

export function runWithTenant<T>(tenantId: string, fn: () => T): T {
  if (!tenantId) throw new Error('runWithTenant requires a tenant id');
  return storage.run({ tenantId }, fn);
}

export function runAsSystem<T>(fn: () => T): T {
  return storage.run({ system: true }, fn);
}

/** Internal: marks the current async scope as already inside a tenant-set transaction. */
export function runInTransaction<T>(fn: () => T): T {
  return storage.run({ ...storage.getStore(), inTransaction: true }, fn);
}

export function currentTenant(): string | undefined {
  return storage.getStore()?.tenantId;
}

export function currentStore(): TenantStore | undefined {
  return storage.getStore();
}
