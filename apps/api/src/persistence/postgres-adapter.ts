import { PrismaPg } from '@prisma/adapter-pg';
import {
  parsePostgresEnvironment,
  postgresPoolOptions,
} from '../config/postgres-config.js';

export function createPostgresAdapter(
  source: Record<string, unknown> = process.env,
  prefix = '',
): PrismaPg {
  return new PrismaPg(
    postgresPoolOptions(parsePostgresEnvironment(source, prefix)),
  );
}
