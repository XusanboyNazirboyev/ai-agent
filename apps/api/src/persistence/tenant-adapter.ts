import type { PrismaPg } from '@prisma/adapter-pg';
import { currentTenant, TenantContextError } from './tenant-context.js';

// The driver adapter types, taken from adapter-pg itself (the
// `@prisma/driver-adapter-utils` package is not a direct dependency).
type SqlDriverAdapter = Pick<
  Awaited<ReturnType<PrismaPg['connect']>>,
  | 'provider'
  | 'adapterName'
  | 'queryRaw'
  | 'executeRaw'
  | 'executeScript'
  | 'startTransaction'
  | 'getConnectionInfo'
  | 'dispose'
>;
type Transaction = Awaited<ReturnType<SqlDriverAdapter['startTransaction']>>;
type SqlQuery = Parameters<SqlDriverAdapter['queryRaw']>[0];
type SqlResultSet = Awaited<ReturnType<SqlDriverAdapter['queryRaw']>>;
type IsolationLevel = Parameters<SqlDriverAdapter['startTransaction']>[0];
type ConnectionInfo = ReturnType<
  NonNullable<SqlDriverAdapter['getConnectionInfo']>
>;
interface SqlDriverAdapterFactory {
  readonly provider: PrismaPg['provider'];
  readonly adapterName: PrismaPg['adapterName'];
  connect(): Promise<SqlDriverAdapter>;
}

/**
 * How the adapter treats the tenant context (RLS enforcement plan S2):
 * - `off`: passes everything through unchanged (today's behaviour);
 * - `warn`: gives PostgreSQL the tenant when one is set; reports a query
 *   without one;
 * - `strict`: like warn, but a query without a tenant fails.
 */
export type RlsContextMode = 'off' | 'warn' | 'strict';

export type MissingTenantReporter = (sql: string) => void;

const SET_TENANT: Omit<SqlQuery, 'args'> = {
  sql: "SELECT set_config('app.tenant_id', $1, true)",
  argTypes: [{ scalarType: 'string', arity: 'scalar' }],
};
const plain = (sql: string): SqlQuery => ({ sql, args: [], argTypes: [] });

async function setTenantOn(tx: Transaction, tenantId: string): Promise<void> {
  await tx.executeRaw({ ...SET_TENANT, args: [tenantId] });
}

/**
 * Wraps the PostgreSQL driver adapter so every statement runs with
 * `app.tenant_id` set to the tenant of the current async context:
 * - a transaction gets it as its first statement (this covers every
 *   interactive `$transaction` and the ones Prisma opens for nested writes);
 * - a single statement outside a transaction runs in its own short
 *   transaction (BEGIN, set, statement, COMMIT), because `set_config(..., true)`
 *   lasts only for a transaction and a pooled connection must not keep it.
 *
 * Note (adapter-pg 7.10): `Transaction.commit()` only releases the connection;
 * the client sends COMMIT / ROLLBACK as statements, so this wrapper does too.
 */
class TenantContextAdapter implements SqlDriverAdapter {
  readonly provider: SqlDriverAdapter['provider'];
  readonly adapterName: SqlDriverAdapter['adapterName'];

  constructor(
    private readonly inner: SqlDriverAdapter,
    private readonly mode: RlsContextMode,
    private readonly reportMissing: MissingTenantReporter,
  ) {
    this.provider = inner.provider;
    this.adapterName = inner.adapterName;
  }

  /** The tenant to apply, or null (after reporting or refusing). */
  private tenantFor(sql: string): string | null {
    if (this.mode === 'off') return null;
    const tenantId = currentTenant();
    if (tenantId) return tenantId;
    if (this.mode === 'strict')
      throw new TenantContextError(
        'A database statement ran without a tenant context',
      );
    this.reportMissing(sql);
    return null;
  }

  private async single<T>(
    query: SqlQuery,
    run: (target: Transaction | SqlDriverAdapter) => Promise<T>,
  ): Promise<T> {
    const tenantId = this.tenantFor(query.sql);
    if (!tenantId) return run(this.inner);
    const tx = await this.inner.startTransaction();
    try {
      await setTenantOn(tx, tenantId);
      const result = await run(tx);
      await tx.executeRaw(plain('COMMIT'));
      await tx.commit();
      return result;
    } catch (error) {
      try {
        await tx.executeRaw(plain('ROLLBACK'));
      } finally {
        await tx.rollback();
      }
      throw error;
    }
  }

  queryRaw(query: SqlQuery): Promise<SqlResultSet> {
    return this.single(query, (target) => target.queryRaw(query));
  }

  executeRaw(query: SqlQuery): Promise<number> {
    return this.single(query, (target) => target.executeRaw(query));
  }

  /** Migrations and scripts: never tenant work. */
  executeScript(script: string): Promise<void> {
    return this.inner.executeScript(script);
  }

  async startTransaction(
    isolationLevel?: IsolationLevel,
  ): Promise<Transaction> {
    const tenantId = this.tenantFor('BEGIN');
    const tx = await this.inner.startTransaction(isolationLevel);
    if (tenantId) {
      try {
        await setTenantOn(tx, tenantId);
      } catch (error) {
        try {
          await tx.executeRaw(plain('ROLLBACK'));
        } finally {
          await tx.rollback();
        }
        throw error;
      }
    }
    return tx;
  }

  getConnectionInfo(): ConnectionInfo {
    return (
      this.inner.getConnectionInfo?.() ?? {
        supportsRelationJoins: false,
      }
    );
  }

  dispose(): Promise<void> {
    return this.inner.dispose();
  }
}

/** The factory Prisma is given: connects the inner adapter, then wraps it. */
export class TenantContextAdapterFactory implements SqlDriverAdapterFactory {
  readonly provider: SqlDriverAdapterFactory['provider'];
  readonly adapterName: SqlDriverAdapterFactory['adapterName'];

  constructor(
    private readonly inner: SqlDriverAdapterFactory,
    private readonly mode: RlsContextMode,
    private readonly reportMissing: MissingTenantReporter = () => undefined,
  ) {
    this.provider = inner.provider;
    this.adapterName = inner.adapterName;
  }

  async connect(): Promise<SqlDriverAdapter> {
    const adapter = await this.inner.connect();
    return this.mode === 'off'
      ? adapter
      : new TenantContextAdapter(adapter, this.mode, this.reportMissing);
  }
}
