/**
 * One-off backfill for ADR 059: bind, per tenant and role, the connector the
 * old "oldest ACTIVE connector with the capability" rule would have picked,
 * and list every tenant where more than one connector qualified.
 *
 *   pnpm backfill:connector-roles            dry run, writes nothing
 *   pnpm backfill:connector-roles --apply    writes the bindings
 *
 * Prints tenant ids, roles and connector keys only (no configuration, no
 * secrets). Roles that are already bound are skipped, so re-running is safe.
 */
import { resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';
import { backfillConnectorRoles } from '../src/connectors/connector-role-backfill.js';
import { createConnectorRegistry } from '../src/connectors/connectors.module.js';
import { TenantConnectorLoader } from '../src/connectors/sync/tenant-connector-loader.js';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { createPostgresAdapter } from '../src/persistence/postgres-adapter.js';
import type { PrismaService } from '../src/persistence/prisma.service.js';
import { PrismaConnectorSecretStore } from '../src/secrets/connector-secret-store.js';
import { createKeyring, SecretCipher } from '../src/secrets/secret-cipher.js';

loadEnv({ path: resolve(process.cwd(), '../../.env'), quiet: true });
const apply = process.argv.includes('--apply');
const env = process.env;
const nodeEnv =
  env.NODE_ENV === 'production' || env.NODE_ENV === 'test'
    ? env.NODE_ENV
    : 'development';

const db = new PrismaClient({ adapter: createPostgresAdapter() });
try {
  const prisma = db as unknown as PrismaService;
  const registry = createConnectorRegistry({
    NODE_ENV: nodeEnv,
    CONNECTOR_OUTBOUND_POLICY:
      env.CONNECTOR_OUTBOUND_POLICY === 'permissive' ? 'permissive' : 'strict',
    CONNECTOR_DEMO_CATALOG: env.CONNECTOR_DEMO_CATALOG === 'on' ? 'on' : 'off',
  });
  // Stored credentials (ADR 032) are needed to load a connector's config.
  const cipher = env.SECRETS_MASTER_KEY
    ? new SecretCipher(
        createKeyring({
          SECRETS_MASTER_KEY: env.SECRETS_MASTER_KEY,
          ...(env.SECRETS_KEY_ID ? { SECRETS_KEY_ID: env.SECRETS_KEY_ID } : {}),
          ...(env.SECRETS_PREVIOUS_KEYS
            ? { SECRETS_PREVIOUS_KEYS: env.SECRETS_PREVIOUS_KEYS }
            : {}),
        }),
      )
    : undefined;
  const loader = new TenantConnectorLoader(
    prisma,
    registry,
    new PrismaConnectorSecretStore(prisma, cipher),
  );
  const report = await backfillConnectorRoles({ prisma, loader, apply });
  console.log(apply ? 'mode: APPLY' : 'mode: dry run (use --apply to write)');
  for (const entry of report)
    console.log(
      `${entry.tenantId} ${entry.role} ${entry.action}` +
        (entry.connectorKey ? ` -> ${entry.connectorKey}` : '') +
        (entry.ambiguous
          ? ` AMBIGUOUS candidates=[${entry.candidates.join(',')}]`
          : ''),
    );
  const ambiguous = report.filter((entry) => entry.ambiguous);
  const bind = report.filter((entry) => entry.action === 'BIND').length;
  console.log(
    `${report.length} role(s) checked, ${bind} ${apply ? 'bound' : 'to bind'}, ` +
      `${ambiguous.length} ambiguous`,
  );
  for (const entry of ambiguous)
    console.log(
      `AMBIGUOUS tenant=${entry.tenantId} role=${entry.role} candidates=[${entry.candidates.join(',')}] (oldest chosen: ${entry.connectorKey})`,
    );
} finally {
  await db.$disconnect();
}
