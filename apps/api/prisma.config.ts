import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import { defineConfig } from 'prisma/config';
import {
  parsePostgresEnvironment,
  postgresConnectionUrl,
} from './src/config/postgres-config.js';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
loadEnv({ path: resolve(repositoryRoot, '.env') });

const requiresConnection = !process.argv.includes('generate');
const datasource = (() => {
  try {
    return {
      url: postgresConnectionUrl(parsePostgresEnvironment(process.env)),
    };
  } catch (error: unknown) {
    if (!requiresConnection) return undefined;
    if (error instanceof Error) throw error;
    throw new Error('Invalid PostgreSQL configuration. Check POSTGRES_* values.');
  }
})();

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  ...(datasource ? { datasource } : {}),
});
