/**
 * Isolated fixtures for the browser end-to-end tests. Works ONLY on the marked
 * agentcore_test database, with unique fake tenants per run (nothing is reset
 * or deleted). Never touches Telegram.
 *
 *   tsx scripts/e2e-fixtures.ts seed <out.json>
 *   tsx scripts/e2e-fixtures.ts customer-message <tenantId> <conversationId> <text>
 *   tsx scripts/e2e-fixtures.ts new-handover <tenantId> <contactName>
 *
 * `seed` also creates two platform console admins (PLATFORM_OWNER and
 * PLATFORM_SUPPORT, ADR 047) and a tenant whose subscription has expired.
 */
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { createPostgresAdapter } from '../src/persistence/postgres-adapter.js';
import { hashPassword } from '../src/webinbox/password.js';
import { backfillPersons } from '../src/ops/backfill-persons.js';
import { ensureLeadStages } from '../src/leads/lead-stage.util.js';
import {
  base32Encode,
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
} from '../src/auth/totp.js';
import { createKeyring, SecretCipher } from '../src/secrets/secret-cipher.js';

loadEnv({ path: resolve(process.cwd(), '../../.env'), quiet: true });
if (process.env.TEST_POSTGRES_DATABASE !== 'agentcore_test') {
  console.error('e2e fixtures require TEST_POSTGRES_DATABASE=agentcore_test');
  process.exit(2);
}
const db = new PrismaClient({
  adapter: createPostgresAdapter(process.env, 'TEST_'),
});

const PASSWORD = 'e2e-password-1';
const FAST = { N: 1024, r: 8, p: 1 };

async function conversation(
  tenantId: string,
  accountId: string,
  name: string,
  options: { slaOverdue?: boolean; text: string },
): Promise<{ id: string; handoverId: string; contactName: string }> {
  const suffix = randomUUID();
  const contact = await db.contact.create({
    data: {
      tenantId,
      channelAccountId: accountId,
      providerUserId: `u-${suffix}`,
      name,
      phone: '+998900000000',
    },
  });
  const created = await db.conversation.create({
    data: {
      tenantId,
      channelAccountId: accountId,
      contactId: contact.id,
      providerChatId: `c-${suffix}`,
      state: 'WAITING_OPERATOR',
      language: 'en',
    },
  });
  await db.message.create({
    data: {
      tenantId,
      conversationId: created.id,
      channelAccountId: accountId,
      authorType: 'CUSTOMER',
      direction: 'INBOUND',
      text: options.text,
      sequence: 1,
      providerChatId: `c-${suffix}`,
    },
  });
  const handover = await db.handover.create({
    data: {
      tenantId,
      conversationId: created.id,
      reasonCode: 'CUSTOMER_REQUEST',
      summary: { topic: 'e2e fixture' },
      slaDueAt: new Date(Date.now() + (options.slaOverdue ? -5 : 30) * 60_000),
    },
  });
  return { id: created.id, handoverId: handover.id, contactName: name };
}

async function tenant(label: string): Promise<{
  tenantId: string;
  accountId: string;
  operators: Record<string, { id: string; email: string }>;
  conversations: { id: string; handoverId: string; contactName: string }[];
}> {
  const run = randomUUID().slice(0, 8);
  const created = await db.tenant.create({
    data: {
      slug: `e2e-${label}-${run}`,
      name: `E2E ${label}`,
      defaultLocale: 'en',
      supportedLocales: ['en'],
      timezone: 'Asia/Tashkent',
      packKey: 'education',
      packVersion: '1',
    },
  });
  const newLeadStageId = await ensureLeadStages(db, created.id);
  const account = await db.channelAccount.create({
    data: {
      tenantId: created.id,
      channelType: 'telegram',
      externalAccountId: `e2e-${label}-${run}`,
      status: 'ACTIVE',
    },
  });
  const operators: Record<string, { id: string; email: string }> = {};
  const roles: [string, 'OPERATOR' | 'VIEWER' | 'ADMIN' | 'OWNER'][] =
    label === 'a'
      ? [
          ['op1', 'OPERATOR'],
          ['op2', 'OPERATOR'],
          ['viewer', 'VIEWER'],
          ['admin', 'ADMIN'],
          // Its own rate-limit budget for the Business Login e2e.
          ['owner', 'OWNER'],
          // Enrols a second factor in the MFA e2e; no other test signs in as it.
          ['mfa', 'ADMIN'],
        ]
      : [['op1', 'OPERATOR']];
  for (const [key, role] of roles) {
    const operator = await db.operator.create({
      data: { tenantId: created.id, displayName: `${label}-${key}`, role },
    });
    const email = `${label}-${key}-${run}@example.test`;
    await db.operatorCredential.create({
      data: {
        tenantId: created.id,
        operatorId: operator.id,
        email,
        passwordHash: await hashPassword(PASSWORD, FAST),
      },
    });
    operators[key] = { id: operator.id, email };
  }
  const conversations = [];
  conversations.push(
    await conversation(created.id, account.id, `Alice ${label}-${run}`, {
      text: `Hello from ${label} one`,
      slaOverdue: label === 'a',
    }),
  );
  if (label === 'a') {
    conversations.push(
      await conversation(created.id, account.id, `Bob ${label}-${run}`, {
        text: 'I need a person please',
      }),
    );
    await db.lead.create({
      data: {
        tenantId: created.id,
        contactId: (
          await db.conversation.findUniqueOrThrow({
            where: { id: conversations[0].id },
          })
        ).contactId,
        conversationId: conversations[0].id,
        pipelineStageId: newLeadStageId,
        score: 'HOT',
        summary: 'e2e lead',
        requirements: {},
        idempotencyKey: `lead-${run}`,
      },
    });
  }
  return {
    tenantId: created.id,
    accountId: account.id,
    operators,
    conversations,
  };
}

/** Console admins of this run (ADR 047); same throwaway password. */
async function platformAdmins(): Promise<
  Record<
    'owner' | 'support' | 'fresh',
    { id: string; email: string; recoveryCodes: string[] }
  >
> {
  const run = randomUUID().slice(0, 8);
  const result = {} as Record<
    'owner' | 'support' | 'fresh',
    { id: string; email: string; recoveryCodes: string[] }
  >;
  // ADR 048: console admins need a second factor. owner and support are
  // enrolled here, with many single-use recovery codes the browser tests
  // sign in with; `fresh` has none, to exercise forced enrolment. The sealing
  // key is the one the e2e API runs with.
  const key = process.env.E2E_SECRETS_KEY;
  if (!key) throw new Error('E2E_SECRETS_KEY is not set');
  const cipher = new SecretCipher(createKeyring({ SECRETS_MASTER_KEY: key }));
  for (const [name, role] of [
    ['owner', 'PLATFORM_OWNER'],
    ['support', 'PLATFORM_SUPPORT'],
    ['fresh', 'PLATFORM_OWNER'],
  ] as const) {
    const email = `platform-${name}-${run}@example.test`;
    const admin = await db.platformAdmin.create({
      data: {
        email,
        displayName: `Platform ${name}`,
        role,
        passwordHash: await hashPassword(PASSWORD, FAST),
      },
    });
    const recoveryCodes = name === 'fresh' ? [] : generateRecoveryCodes(80);
    if (name !== 'fresh') {
      const secret = generateTotpSecret();
      const sealed = cipher.seal(
        base32Encode(secret),
        `mfa:platform:${admin.id}`,
      );
      await db.platformAdmin.update({
        where: { id: admin.id },
        data: {
          totpKeyId: sealed.keyId,
          totpNonce: Uint8Array.from(sealed.nonce),
          totpCiphertext: Uint8Array.from(sealed.ciphertext),
          totpEnabledAt: new Date(),
          mfaRecoveryHashes: recoveryCodes.map((code) =>
            hashRecoveryCode(secret, code.replace('-', '')),
          ),
        },
      });
    }
    result[name] = { id: admin.id, email, recoveryCodes };
  }
  return result;
}

/**
 * A billed tenant whose subscription expired (fictional plan and payment):
 * the assistant is paused, the team signs in and sees the banner.
 */
async function expiredTenant(): Promise<{
  tenantId: string;
  owner: { id: string; email: string };
  planName: string;
}> {
  const run = randomUUID().slice(0, 8);
  const tenant = await db.tenant.create({
    data: {
      slug: `e2e-expired-${run}`,
      name: 'E2E expired',
      defaultLocale: 'en',
      supportedLocales: ['en'],
      timezone: 'Asia/Tashkent',
      packKey: 'education',
      packVersion: '1',
      config: { billing: { required: true } },
    },
  });
  await ensureLeadStages(db, tenant.id);
  const planName = `E2E plan ${run}`;
  const plan = await db.subscriptionPlan.create({
    data: {
      code: `e2e-${run}`,
      name: planName,
      priceMinor: 15_000_000n,
      currency: 'UZS',
      periodDays: 30,
      limits: { maxOperators: 5 },
    },
  });
  const day = 86_400_000;
  const subscription = await db.tenantSubscription.create({
    data: {
      tenantId: tenant.id,
      planId: plan.id,
      status: 'EXPIRED',
      currentPeriodStart: new Date(Date.now() - 40 * day),
      currentPeriodEnd: new Date(Date.now() - 10 * day),
      graceUntil: new Date(Date.now() - 7 * day),
    },
  });
  await db.subscriptionPayment.create({
    data: {
      tenantId: tenant.id,
      subscriptionId: subscription.id,
      provider: 'MANUAL',
      providerRef: `manual:e2e-${run}`,
      amountMinor: 15_000_000n,
      currency: 'UZS',
      status: 'PAID',
      paidAt: new Date(Date.now() - 40 * day),
      safeSummary: {},
    },
  });
  const operator = await db.operator.create({
    data: { tenantId: tenant.id, displayName: 'expired-owner', role: 'OWNER' },
  });
  const email = `expired-owner-${run}@example.test`;
  await db.operatorCredential.create({
    data: {
      tenantId: tenant.id,
      operatorId: operator.id,
      email,
      passwordHash: await hashPassword(PASSWORD, FAST),
    },
  });
  return { tenantId: tenant.id, owner: { id: operator.id, email }, planName };
}

const [command, ...args] = process.argv.slice(2);
try {
  if (command === 'seed') {
    const out = args[0];
    const a = await tenant('a');
    const b = await tenant('b');
    const platform = await platformAdmins();
    const expired = await expiredTenant();
    // ADR 052: fixture contacts are created directly; give them persons.
    for (const seeded of [a, b, expired])
      await backfillPersons(db, { tenantId: seeded.tenantId });
    writeFileSync(
      out,
      JSON.stringify({ password: PASSWORD, a, b, platform, expired }, null, 2),
    );
    console.log('seeded');
  } else if (command === 'customer-message') {
    const [tenantId, conversationId, text] = args;
    const row = await db.conversation.findFirstOrThrow({
      where: { tenantId, id: conversationId },
    });
    const last = await db.message.aggregate({
      where: { tenantId, conversationId },
      _max: { sequence: true },
    });
    await db.message.create({
      data: {
        tenantId,
        conversationId,
        channelAccountId: row.channelAccountId,
        authorType: 'CUSTOMER',
        direction: 'INBOUND',
        text,
        sequence: (last._max.sequence ?? 0) + 1,
        providerChatId: row.providerChatId,
      },
    });
    console.log('ok');
  } else if (command === 'uncertain-action') {
    // A confirmed action whose CRM outcome could not be determined (fictional).
    const [tenantId, conversationId] = args;
    const proposal = await db.actionProposal.create({
      data: {
        tenantId,
        conversationId,
        actionKey: 'course_enquiry',
        operation: 'createLead',
        packRef: 'education@1',
        payload: { 'slots.subject': 'IELTS', 'contact.phone': '+998900000000' },
        digest: 'e2e'.padEnd(64, '0'),
        status: 'UNCERTAIN',
        expiresAt: new Date(Date.now() + 3_600_000),
        proposedTurnKey: `e2e-${randomUUID()}`,
        confirmedAt: new Date(),
        outcomeAt: new Date(),
        errorCode: 'CONNECTOR_TIMEOUT',
      },
    });
    await db.connectorOperation.create({
      data: {
        tenantId,
        kind: 'createLead',
        subjectType: 'action_proposal',
        subjectId: proposal.id,
        idempotencyKey: `createLead:action_proposal:${proposal.id}`,
        status: 'UNCERTAIN',
        attempts: 1,
        attemptMode: 'none',
        lastExecution: 'UNCERTAIN',
        lastErrorCode: 'CONNECTOR_TIMEOUT',
      },
    });
    console.log(JSON.stringify({ proposalId: proposal.id }));
  } else if (command === 'new-handover') {
    const [tenantId, name] = args;
    const account = await db.channelAccount.findFirstOrThrow({
      where: { tenantId },
    });
    const created = await conversation(tenantId, account.id, name, {
      text: 'New customer',
    });
    await backfillPersons(db, { tenantId });
    console.log(JSON.stringify(created));
  } else {
    console.error('unknown command');
    process.exit(2);
  }
} finally {
  await db.$disconnect();
}
