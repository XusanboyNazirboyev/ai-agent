import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';
import type { PostgresEnvironment } from '../src/config/postgres-config.js';
import { Pool } from 'pg';
import {
  parsePostgresEnvironment,
  postgresPoolOptions,
} from '../src/config/postgres-config.js';

loadEnv({ path: resolve(process.cwd(), '../../.env') });

const databaseName = 'agentcore_test';
const databaseComment = 'AgentCore isolated integration-test database';
const apiDirectory = process.cwd();

function getTestDatabaseConfig(): PostgresEnvironment {
  const test = parsePostgresEnvironment(process.env, 'TEST_');
  const development = parsePostgresEnvironment(process.env);
  if (test.POSTGRES_DATABASE !== databaseName) {
    throw new Error(`TEST_POSTGRES_DATABASE must be ${databaseName}`);
  }
  if (sameDatabase(test, development)) {
    throw new Error(
      'The integration-test database must differ from POSTGRES_DATABASE',
    );
  }
  return test;
}

function sameDatabase(
  left: ReturnType<typeof parsePostgresEnvironment>,
  right: ReturnType<typeof parsePostgresEnvironment>,
): boolean {
  return (
    left.POSTGRES_HOST === right.POSTGRES_HOST &&
    left.POSTGRES_PORT === right.POSTGRES_PORT &&
    left.POSTGRES_DATABASE === right.POSTGRES_DATABASE
  );
}

async function createTestDatabase(
  config: ReturnType<typeof parsePostgresEnvironment>,
): Promise<void> {
  const pool = new Pool({
    ...postgresPoolOptions(config),
    database: 'postgres',
  });
  try {
    const existing = await pool.query<{
      datname: string;
      comment: string | null;
    }>(
      `SELECT database.datname, shobj_description(database.oid, 'pg_database') AS comment
       FROM pg_database AS database WHERE database.datname = $1`,
      [databaseName],
    );

    if (existing.rowCount) {
      if (existing.rows[0]?.comment !== databaseComment) {
        throw new Error(
          `${databaseName} already exists without the AgentCore test-database marker; refusing to use it`,
        );
      }
      return;
    }

    await pool.query(`CREATE DATABASE "${databaseName}"`);
    await pool.query(
      `COMMENT ON DATABASE "${databaseName}" IS '${databaseComment}'`,
    );
  } finally {
    await pool.end();
  }
}

function runPrisma(
  args: string[],
  config: ReturnType<typeof parsePostgresEnvironment>,
): void {
  const result = spawnSync('pnpm', ['exec', 'prisma', ...args], {
    cwd: apiDirectory,
    stdio: 'inherit',
    env: {
      ...process.env,
      NODE_ENV: 'test',
      POSTGRES_HOST: config.POSTGRES_HOST,
      POSTGRES_PORT: String(config.POSTGRES_PORT),
      POSTGRES_DATABASE: config.POSTGRES_DATABASE,
      POSTGRES_USER: config.POSTGRES_USER,
      POSTGRES_PASSWORD: config.POSTGRES_PASSWORD,
      POSTGRES_SSL_MODE: config.POSTGRES_SSL_MODE,
    },
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Prisma command failed with exit code ${result.status}`);
  }
}

async function main(): Promise<void> {
  const operation = process.argv[2];
  const testConfig = getTestDatabaseConfig();

  if (operation === 'prepare') {
    await createTestDatabase(testConfig);
    runPrisma(['migrate', 'deploy'], testConfig);
    return;
  }
  if (operation === 'seed') {
    await createTestDatabase(testConfig);
    runPrisma(['db', 'seed'], testConfig);
    return;
  }
  if (operation === 'drift') {
    runPrisma(
      [
        'migrate',
        'diff',
        '--from-config-datasource',
        '--to-schema',
        'prisma/schema.prisma',
        '--exit-code',
      ],
      testConfig,
    );
    return;
  }

  throw new Error('Usage: test-database.ts <prepare|seed|drift>');
}

main().catch((error: unknown) => {
  console.error(
    error instanceof Error ? error.message : 'Test database setup failed',
  );
  process.exitCode = 1;
});
