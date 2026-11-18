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

/**
 * Environment for a spec that boots the real AppModule, set after the
 * `TEST_POSTGRES_*` copy to `POSTGRES_*`. Strict: `RLS_CONTEXT_MODE=strict`,
 * the main pool as the NOBYPASSRLS role and the test owner as the privileged
 * pool, as `rls-http-context.integration.spec.ts` runs it. Otherwise nothing
 * changes.
 */
export function appModuleEnvironment(): Record<string, string> {
  if (!RLS_STRICT) return {};
  const owner = process.env.TEST_POSTGRES_USER;
  if (!owner) throw new Error('TEST_POSTGRES_USER is required');
  return {
    RLS_CONTEXT_MODE: 'strict',
    POSTGRES_USER: RLS_APP_ROLE,
    POSTGRES_PASSWORD: rlsAppRolePassword(),
    POSTGRES_ADMIN_USER: owner,
    ...(process.env.TEST_POSTGRES_PASSWORD === undefined
      ? {}
      : { POSTGRES_ADMIN_PASSWORD: process.env.TEST_POSTGRES_PASSWORD }),
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function tenantIdIn(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object' || !('tenantId' in value))
    return undefined;
  const { tenantId } = value as { tenantId: unknown };
  return typeof tenantId === 'string' ? tenantId : undefined;
}

/** The request field each guard sets: the session's, the API token's. */
const REQUEST_IDENTITIES = ['principal', 'operator'] as const;

function requestTenant(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  for (const key of REQUEST_IDENTITIES)
    if (key in value) {
      const tenantId = tenantIdIn((value as Record<string, unknown>)[key]);
      if (tenantId) return tenantId;
    }
  return undefined;
}

/**
 * The tenant a call names: `{ tenantId }` in an argument, a request carrying
 * the `principal` the session guard set or the `operator` the API token guard
 * set, or the `(tx, tenantId, ...)` shape.
 * A leading id is not guessed (it may be an account or conversation id):
 * such calls pass `tenantArg` or set the tenant explicitly.
 */
function tenantOf(args: readonly unknown[]): string | undefined {
  for (const arg of args) {
    const tenantId = tenantIdIn(arg) ?? requestTenant(arg);
    if (tenantId) return tenantId;
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

/** How `tenantScoped` finds the tenant a call names. */
export interface TenantScopedOptions {
  /**
   * The position of a plain tenant id argument, for services whose methods
   * take `(tenantId, ...)`; such ids are not guessed otherwise.
   */
  readonly tenantArg?: number;
}

function tenantAt(
  args: readonly unknown[],
  index: number | undefined,
): string | undefined {
  if (index === undefined) return undefined;
  const value = args[index];
  return typeof value === 'string' && UUID.test(value) ? value : undefined;
}

/**
 * The service as a request, job or scan would call it: each method runs
 * under the tenant its arguments name (none named: no tenant, so strict mode
 * refuses its statements). Spec-only; production sets the tenant at the edge.
 */
export function tenantScoped<T extends object>(
  service: T,
  options: TenantScopedOptions = {},
): T {
  return new Proxy(service, {
    get(target, key, receiver): unknown {
      const value: unknown = Reflect.get(target, key, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]): unknown => {
        const call = (): unknown =>
          (value as (...a: unknown[]) => unknown).apply(target, args);
        const tenantId = tenantAt(args, options.tenantArg) ?? tenantOf(args);
        return tenantId ? runWithTenant(tenantId, call) : call();
      };
    },
  });
}
