import type { PrismaClient } from '../generated/prisma/client.js';
import { currentStore, runInTransaction } from './tenant-context.js';

/** Models with tenant-isolation policies (ADR 050/054), as named in schema.prisma. */
export const RLS_MODELS: ReadonlySet<string> = new Set([
  'Contact',
  'Conversation',
  'Message',
  'Lead',
  'Handover',
  'KnowledgeChunk',
  'Person',
  'PersonMerge',
]);

export type RlsMode = 'off' | 'warn' | 'strict';

export function parseRlsMode(value: string | undefined): RlsMode {
  if (value === undefined || value === '') return 'off';
  if (value === 'off' || value === 'warn' || value === 'strict') return value;
  throw new Error(`DB_RLS_MODE must be off, warn or strict (got "${value}")`);
}

export interface RlsOptions {
  readonly mode: RlsMode;
  readonly warn?: (message: string) => void;
}

export type RlsClient = PrismaClient;

type TxClient = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];

/**
 * Wraps `base` so operations on RLS models carry `set_config('app.tenant_id', id, true)`
 * as the first statement of the transaction they run in. Only transaction-local
 * settings are used, so nothing leaks through the connection pool.
 *
 * The hook queries through `base` (the un-extended client) so the wrapping
 * transaction does not re-enter the hook.
 */
export function withRlsExtension(
  base: PrismaClient,
  options: RlsOptions,
): RlsClient {
  const warned = new Set<string>();
  const warn =
    options.warn ??
    ((m: string): void => {
      console.warn(m);
    });
  const setTenant = (
    tx: Pick<TxClient, '$executeRaw'>,
    tenantId: string,
  ): ReturnType<TxClient['$executeRaw']> =>
    tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;

  const extended = base.$extends({
    name: 'rls',
    client: {
      /**
       * Interactive form: sets the tenant once as the callback's first statement,
       * and marks the scope so model calls inside do not open another transaction.
       * Array (batch) form: the set_config statement is prepended when a tenant
       * context exists. Without a context it follows the mode policy.
       */
      $transaction(arg: unknown, txOptions?: unknown): unknown {
        const store = currentStore();
        const baseTx = base.$transaction as (
          a: unknown,
          o?: unknown,
        ) => unknown;
        if (options.mode === 'off' || store?.system)
          return baseTx.call(base, arg, txOptions);
        if (typeof arg === 'function') {
          const fn = arg as (tx: TxClient) => Promise<unknown>;
          const tenantId = store?.tenantId;
          if (!tenantId) {
            // No context: the callback may still only touch non-RLS tables; model
            // calls inside will be judged by the hook (mode policy) per operation.
            return baseTx.call(base, fn, txOptions);
          }
          // The callback receives the un-extended `tx`, so model calls on it never
          // re-enter the hook. A call on the outer extended client inside the
          // callback is a different connection and is wrapped on its own.
          return baseTx.call(
            base,
            async (tx: TxClient) => {
              await setTenant(tx, tenantId);
              return fn(tx);
            },
            txOptions,
          );
        }
        const tenantId = store?.tenantId;
        if (Array.isArray(arg) && tenantId) {
          return (
            runInTransaction(() =>
              baseTx.call(
                base,
                [setTenant(base, tenantId), ...(arg as unknown[])],
                txOptions,
              ),
            ) as Promise<unknown[]>
          ).then((rows) => rows.slice(1));
        }
        return baseTx.call(base, arg, txOptions);
      },
    },
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          if (options.mode === 'off' || !RLS_MODELS.has(model))
            return query(args);
          const store = currentStore();
          if (store?.system || store?.inTransaction) return query(args);
          const tenantId = store?.tenantId;
          if (!tenantId) {
            const what = `${model}.${operation}`;
            if (options.mode === 'strict')
              throw new Error(
                `RLS strict: ${what} ran with no tenant context (use runWithTenant or runAsSystem)`,
              );
            if (!warned.has(what)) {
              warned.add(what);
              warn(`RLS warn: ${what} ran with no tenant context`);
            }
            return query(args);
          }
          const [, result] = await base.$transaction([
            setTenant(base, tenantId),
            query(args),
          ] as never);
          return result;
        },
      },
    },
  });
  // The `$transaction` override above is typed loosely; expose the client type.
  return extended as unknown as RlsClient;
}
