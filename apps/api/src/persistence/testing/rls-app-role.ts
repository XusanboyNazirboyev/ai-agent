import { createHash } from 'node:crypto';
import type { PrismaClient } from '../../generated/prisma/client.js';

/** A login role that cannot bypass RLS, for tests only (RLS plan S2/S8). */
export const RLS_APP_ROLE = 'agentcore_rls_app_test';

export interface RlsAppRole {
  readonly user: string;
  readonly password: string;
}

/** The role's password, derived from the owner's test password. */
export function rlsAppRolePassword(): string {
  return createHash('sha256')
    .update(`rls-app-role:${process.env.TEST_POSTGRES_PASSWORD ?? ''}`)
    .digest('hex')
    .slice(0, 32);
}

/**
 * Creates or refreshes the NOBYPASSRLS login role with DML rights on the given
 * schemas, when the connected user may (a superuser: the CI database user).
 * Returns null otherwise (the local test user has no CREATEROLE).
 *
 * Several spec files may call this at the same time from different workers:
 * the work runs under one advisory lock, and the password is derived from the
 * owner's test password, so every caller sets and uses the same one.
 */
export async function ensureRlsAppRole(
  owner: PrismaClient,
  schemas: readonly string[] = ['public'],
): Promise<RlsAppRole | null> {
  const [me] = await owner.$queryRaw<{ superuser: boolean }[]>`
    SELECT rolsuper AS superuser FROM pg_roles WHERE rolname = current_user`;
  if (!me?.superuser) return null;
  const password = rlsAppRolePassword();
  await owner.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${RLS_APP_ROLE}))`;
    const [exists] = await tx.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_roles WHERE rolname = ${RLS_APP_ROLE}`;
    if (!exists?.n) await tx.$executeRawUnsafe(`CREATE ROLE ${RLS_APP_ROLE}`);
    await tx.$executeRawUnsafe(
      `ALTER ROLE ${RLS_APP_ROLE} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${password}'`,
    );
    for (const schema of schemas) {
      await tx.$executeRawUnsafe(
        `GRANT USAGE ON SCHEMA ${schema} TO ${RLS_APP_ROLE}`,
      );
      await tx.$executeRawUnsafe(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${schema} TO ${RLS_APP_ROLE}`,
      );
      await tx.$executeRawUnsafe(
        `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${schema} TO ${RLS_APP_ROLE}`,
      );
    }
  });
  return { user: RLS_APP_ROLE, password };
}
