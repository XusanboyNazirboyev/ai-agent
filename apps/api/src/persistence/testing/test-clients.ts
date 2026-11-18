import { PrismaPg } from '@prisma/adapter-pg';
import {
  parsePostgresEnvironment,
  postgresPoolOptions,
} from '../../config/postgres-config.js';
import { PrismaClient } from '../../generated/prisma/client.js';
import { createPostgresAdapter } from '../postgres-adapter.js';
import { TenantContextAdapterFactory } from '../tenant-adapter.js';
import { runWithTenant } from '../tenant-context.js';
import { RLS_APP_ROLE, rlsAppRolePassword } from './rls-app-role.js';

/**
 * RLS plan S8b: integration specs keep two clients apart.
 *
 * - `ownerClient()` seeds and cleans up fixtures across tenants: the test
 *   owner, never bound by RLS.
 * - `appClient()` is what the code under test receives. In the normal suite
 *   it is the same plain client. Under `pnpm test:rls:strict`
 *   (TEST_RLS_STRICT=1, `vitest.rls-strict.config.mts`) it runs in strict
 *   mode as the NOBYPASSRLS role the config's global setup creates: a
 *   statement without a tenant throws, and policies hide other tenants'
 *   rows. A spec on the strict list therefore calls the code under test the
 *   way production does, inside `runWithTenant` where a request, a job or a
 *   scan would set the tenant.
 */
export const RLS_STRICT = process.env.TEST_RLS_STRICT === '1';

export function ownerClient(): PrismaClient {
  return new PrismaClient({
    adapter: createPostgresAdapter(process.env, 'TEST_'),
  });
}

/** Pool settings a spec may narrow (a one-connection pool, a session name). */
export interface TestPoolOptions {
  readonly max?: number;
  readonly application_name?: string;
}

export function appClient(pool: TestPoolOptions = {}): PrismaClient {
  const env = RLS_STRICT
    ? {
        ...process.env,
        TEST_POSTGRES_USER: RLS_APP_ROLE,
        TEST_POSTGRES_PASSWORD: rlsAppRolePassword(),
      }
    : process.env;
  const adapter = new PrismaPg({
    ...postgresPoolOptions(parsePostgresEnvironment(env, 'TEST_')),
    ...pool,
  });
  return new PrismaClient({
    adapter: RLS_STRICT
      ? new TenantContextAdapterFactory(adapter, 'strict', () => undefined)
      : adapter,
  });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/**
 * The tenant a service call names: `{ tenantId }` in an argument, or the
 * `(tx, tenantId, ...)` shape. A leading id is not guessed (it may be an
 * account or conversation id): such calls set the tenant explicitly.
 */
function tenantOf(args: readonly unknown[]): string | undefined {
  for (const arg of args)
    if (arg !== null && typeof arg === 'object' && 'tenantId' in arg) {
      const { tenantId } = arg as { tenantId: unknown };
      if (typeof tenantId === 'string') return tenantId;
    }
  const [first, second] = args;
  if (
    first !== null &&
    typeof first === 'object' &&
    typeof second === 'string' &&
    UUID.test(second)
  )
    return second;
  return undefined;
}

/**
 * The service as a request, job or scan would call it: each method runs
 * under the tenant its arguments name (none named: no tenant, so strict mode
 * refuses its statements). Spec-only; production sets the tenant at the edge.
 */
export function tenantScoped<T extends object>(service: T): T {
  return new Proxy(service, {
    get(target, key, receiver): unknown {
      const value: unknown = Reflect.get(target, key, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]): unknown => {
        const call = (): unknown =>
          (value as (...a: unknown[]) => unknown).apply(target, args);
        const tenantId = tenantOf(args);
        return tenantId ? runWithTenant(tenantId, call) : call();
      };
    },
  });
}
