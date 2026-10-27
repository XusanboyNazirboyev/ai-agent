import { PrismaPg } from '@prisma/adapter-pg';
import {
  parsePostgresEnvironment,
  postgresPoolOptions,
} from '../config/postgres-config.js';
import type { PrismaClient } from '../generated/prisma/client.js';

/**
 * DEF-007: the adapter writes DateTime values without an offset, so they are
 * stored correctly only in a UTC session. The pool asks for UTC at startup;
 * this check fails loudly when something between the app and PostgreSQL (a
 * pooler that drops startup options, a role or database default applied
 * later) leaves the session in another zone.
 */
export async function assertUtcSession(
  client: Pick<PrismaClient, '$queryRaw'>,
): Promise<void> {
  const [row] = await client.$queryRaw<{ zone: string }[]>`
    SELECT current_setting('TimeZone') AS zone`;
  if (!['UTC', 'Etc/UTC'].includes(row?.zone ?? '')) {
    throw new Error(
      `PostgreSQL session TimeZone is ${row?.zone ?? 'unknown'}, not UTC: stored timestamps would be shifted (DEF-007)`,
    );
  }
}

export function createPostgresAdapter(
  source: Record<string, unknown> = process.env,
  prefix = '',
): PrismaPg {
  return new PrismaPg(
    postgresPoolOptions(parsePostgresEnvironment(source, prefix)),
  );
}
