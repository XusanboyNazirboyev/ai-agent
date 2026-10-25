/**
 * Isolated fixtures for the browser end-to-end tests. Works ONLY on the marked
 * agentcore_test database, with unique fake tenants per run (nothing is reset
 * or deleted). Never touches Telegram.
 *
 *   tsx scripts/e2e-fixtures.ts seed <out.json>
 *   tsx scripts/e2e-fixtures.ts customer-message <tenantId> <conversationId> <text>
 *   tsx scripts/e2e-fixtures.ts new-handover <tenantId> <contactName>
 */
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { createPostgresAdapter } from '../src/persistence/postgres-adapter.js';
import { hashPassword } from '../src/webinbox/password.js';

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
  const account = await db.channelAccount.create({
    data: {
      tenantId: created.id,
      channelType: 'telegram',
      externalAccountId: `e2e-${label}-${run}`,
      status: 'ACTIVE',
    },
  });
  const operators: Record<string, { id: string; email: string }> = {};
  const roles: [string, 'OPERATOR' | 'VIEWER'][] =
    label === 'a'
      ? [
          ['op1', 'OPERATOR'],
          ['op2', 'OPERATOR'],
          ['viewer', 'VIEWER'],
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

const [command, ...args] = process.argv.slice(2);
try {
  if (command === 'seed') {
    const out = args[0];
    const a = await tenant('a');
    const b = await tenant('b');
    writeFileSync(out, JSON.stringify({ password: PASSWORD, a, b }, null, 2));
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
    console.log(JSON.stringify(created));
  } else {
    console.error('unknown command');
    process.exit(2);
  }
} finally {
  await db.$disconnect();
}
