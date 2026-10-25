/**
 * Development only: one fake tenant and one SHADOW test channel account for a
 * test bot, so a developer can try real Telegram traffic. Prints the account
 * UUID (not a secret). Refuses production. Never stores the bot token.
 *
 *   TELEGRAM_TEST_OPERATOR_CHAT_ID=<group id> pnpm telegram:account
 */
import { resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { createPostgresAdapter } from '../src/persistence/postgres-adapter.js';
import { assertLocalDevelopment } from '../src/dev/dev-guards.js';

loadEnv({ path: resolve(process.cwd(), '../../.env') });
assertLocalDevelopment(process.env);

const operatorChatId = process.env.TELEGRAM_TEST_OPERATOR_CHAT_ID;
if (!operatorChatId) {
  console.log('Missing environment variable: TELEGRAM_TEST_OPERATOR_CHAT_ID');
  process.exit(2);
}

const prisma = new PrismaClient({ adapter: createPostgresAdapter() });
const tenant = await prisma.tenant.upsert({
  where: { slug: 'dev-telegram-test' },
  create: {
    slug: 'dev-telegram-test',
    name: 'Dev Telegram test tenant (fake data)',
    defaultLocale: 'uz-Latn',
    supportedLocales: ['uz-Latn', 'uz-Cyrl', 'ru', 'en'],
    timezone: 'Asia/Tashkent',
    packKey: 'education',
    packVersion: '1',
    enabledCapabilities: ['catalog.search'],
  },
  update: {},
});
const account = await prisma.channelAccount.upsert({
  where: {
    channelType_externalAccountId: {
      channelType: 'telegram',
      externalAccountId: 'dev-telegram-test-bot',
    },
  },
  create: {
    tenantId: tenant.id,
    channelType: 'telegram',
    externalAccountId: 'dev-telegram-test-bot',
    status: 'ACTIVE',
    agentMode: 'SHADOW',
    isTestAccount: true,
    operatorChatId,
  },
  // Never raises the mode: a developer changes it with scripts/agent-mode.ts.
  update: { status: 'ACTIVE', isTestAccount: true, operatorChatId },
});
console.log(
  `TELEGRAM_CHANNEL_ACCOUNT_ID=${account.id} (mode ${account.agentMode})`,
);
await prisma.$disconnect();
