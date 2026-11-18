import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';
import { ensureRlsAppRole } from './rls-app-role.js';
import { ownerClient } from './test-clients.js';

/** Creates the NOBYPASSRLS role once before the strict list runs (S8b). */
export default async function setup(): Promise<void> {
  loadEnv({ path: resolve(process.cwd(), '../../.env'), quiet: true });
  if (process.env.TEST_POSTGRES_DATABASE !== 'agentcore_test')
    throw new Error('The strict RLS run requires agentcore_test');
  const owner = ownerClient();
  try {
    if (!(await ensureRlsAppRole(owner)))
      throw new Error(
        'The strict RLS run needs a test user that may create roles (CI)',
      );
  } finally {
    await owner.$disconnect();
  }
}
