import { config as loadEnv } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { ExecutionContext } from '@nestjs/common';
import { afterAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../generated/prisma/client.js';
import { createPostgresAdapter } from '../persistence/postgres-adapter.js';
import type { PrismaService } from '../persistence/prisma.service.js';
import { HandoverService } from './handover.service.js';
import {
  hashToken,
  newOperatorToken,
  OperatorTokenGuard,
  type AuthenticatedOperator,
} from './operator-auth.js';
import { OperatorCommandsController } from './operator-commands.controller.js';

loadEnv({ path: resolve(process.cwd(), '../../.env'), quiet: true });
if (process.env.TEST_POSTGRES_DATABASE !== 'agentcore_test') {
  throw new Error('Operator API integration tests require agentcore_test');
}
const db = new PrismaClient({
  adapter: createPostgresAdapter(process.env, 'TEST_'),
});
const prisma = db as unknown as PrismaService;
afterAll(async () => {
  await db.$disconnect();
});

const guard = new OperatorTokenGuard(prisma);
const controller = new OperatorCommandsController(new HandoverService(prisma));

async function authenticate(
  token: string | undefined,
): Promise<AuthenticatedOperator> {
  const request: {
    headers: Record<string, string>;
    operator?: AuthenticatedOperator;
  } = {
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
  };
  const context = {
    switchToHttp: (): { getRequest: () => typeof request } => ({
      getRequest: () => request,
    }),
  } as unknown as ExecutionContext;
  await guard.canActivate(context);
  return request.operator!;
}

async function world(): Promise<{
  tenantId: string;
  handoverId: string;
  conversationId: string;
  tokens: [string, string];
  ids: [string, string];
}> {
  const suffix = randomUUID();
  const tenant = await db.tenant.create({
    data: {
      slug: `api-${suffix}`,
      name: 'API fixture',
      defaultLocale: 'en',
      supportedLocales: ['en'],
      timezone: 'UTC',
      packKey: 'education',
      packVersion: '1',
    },
  });
  const account = await db.channelAccount.create({
    data: {
      tenantId: tenant.id,
      channelType: 'telegram',
      externalAccountId: `api-${suffix}`,
      status: 'ACTIVE',
    },
  });
  const contact = await db.contact.create({
    data: {
      tenantId: tenant.id,
      channelAccountId: account.id,
      providerUserId: `u-${suffix}`,
    },
  });
  const conversation = await db.conversation.create({
    data: {
      tenantId: tenant.id,
      channelAccountId: account.id,
      contactId: contact.id,
      providerChatId: `c-${suffix}`,
      state: 'WAITING_OPERATOR',
    },
  });
  const handover = await db.handover.create({
    data: {
      tenantId: tenant.id,
      conversationId: conversation.id,
      reasonCode: 'CUSTOMER_REQUEST',
      summary: {},
    },
  });
  const tokens: string[] = [];
  const ids: string[] = [];
  for (const name of ['a', 'b']) {
    const operator = await db.operator.create({
      data: { tenantId: tenant.id, displayName: name, role: 'OPERATOR' },
      select: { id: true },
    });
    const token = newOperatorToken();
    await db.operatorApiToken.create({
      data: {
        tenantId: tenant.id,
        operatorId: operator.id,
        tokenHash: hashToken(token),
        label: name,
      },
    });
    tokens.push(token);
    ids.push(operator.id);
  }
  return {
    tenantId: tenant.id,
    handoverId: handover.id,
    conversationId: conversation.id,
    tokens: tokens as [string, string],
    ids: ids as [string, string],
  };
}

const key = (): string => `key-${randomUUID()}`;
const as = (
  operator: AuthenticatedOperator,
): { operator: AuthenticatedOperator } => ({ operator });

describe('operator token authentication', () => {
  it('resolves tenant and operator from the credential, storing only a hash', async () => {
    const w = await world();
    const operator = await authenticate(w.tokens[0]);
    expect(operator).toEqual({ tenantId: w.tenantId, operatorId: w.ids[0] });
    const row = await db.operatorApiToken.findFirstOrThrow({
      where: { operatorId: w.ids[0] },
    });
    expect(row.tokenHash).toBe(hashToken(w.tokens[0]));
    expect(JSON.stringify(row)).not.toContain(w.tokens[0]);
    expect(row.lastUsedAt).not.toBeNull();
  });

  it('refuses missing, unknown, revoked and deactivated credentials identically', async () => {
    const w = await world();
    const failures = [
      undefined,
      'acop_unknown',
      'not-a-token',
      w.tokens[0] + 'x',
    ];
    await db.operatorApiToken.updateMany({
      where: { operatorId: w.ids[1] },
      data: { revokedAt: new Date() },
    });
    failures.push(w.tokens[1]);
    await db.operator.update({
      where: { id: w.ids[0] },
      data: { isActive: false },
    });
    failures.push(w.tokens[0]);
    for (const token of failures)
      await expect(authenticate(token)).rejects.toMatchObject({
        response: { code: 'UNAUTHENTICATED' },
      });
  });
});

describe('operator command API', () => {
  it('takes over once, answers a repeated key as duplicate, and requires the key', async () => {
    const w = await world();
    const a = await authenticate(w.tokens[0]);
    const k = key();
    expect(await controller.takeOver(w.handoverId, k, as(a))).toMatchObject({
      status: 'ok',
      state: 'OPERATOR_ACTIVE',
    });
    expect(await controller.takeOver(w.handoverId, k, as(a))).toMatchObject({
      status: 'duplicate',
    });
    await expect(
      controller.takeOver(w.handoverId, undefined, as(a)),
    ).rejects.toMatchObject({
      response: { code: 'IDEMPOTENCY_KEY_REQUIRED' },
    });
    await expect(
      controller.takeOver(w.handoverId, 'short', as(a)),
    ).rejects.toMatchObject({
      response: { code: 'IDEMPOTENCY_KEY_REQUIRED' },
    });
  });

  it('answers the loser of a take-over race with 409 and a clear code', async () => {
    const w = await world();
    const [a, b] = await Promise.all(w.tokens.map((t) => authenticate(t)));
    const results = await Promise.allSettled([
      controller.takeOver(w.handoverId, key(), as(a)),
      controller.takeOver(w.handoverId, key(), as(b)),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = results.find(
      (r) => r.status === 'rejected',
    ) as PromiseRejectedResult;
    expect(lost.reason).toMatchObject({
      status: 409,
      response: { code: 'ALREADY_TAKEN', i18nKey: 'errors.already_taken' },
    });
  });

  it('delivers replies only for the owner, validates bodies, and keeps notes internal', async () => {
    const w = await world();
    const [a, b] = await Promise.all(w.tokens.map((t) => authenticate(t)));
    await controller.takeOver(w.handoverId, key(), as(a));
    const k = key();
    const sent = await controller.reply(
      w.handoverId,
      k,
      { text: 'Hello from the API' },
      as(a),
    );
    expect(sent).toMatchObject({ status: 'ok', messageId: expect.any(String) });
    expect(
      await controller.reply(
        w.handoverId,
        k,
        { text: 'Hello from the API' },
        as(a),
      ),
    ).toMatchObject({
      status: 'duplicate',
    });
    await expect(
      controller.reply(w.handoverId, key(), { text: 'x' }, as(b)),
    ).rejects.toMatchObject({
      status: 409,
      response: { code: 'NOT_ASSIGNED' },
    });
    await expect(
      controller.reply(w.handoverId, key(), { text: '' }, as(a)),
    ).rejects.toMatchObject({
      response: { code: 'INVALID_BODY' },
    });
    await expect(
      controller.reply(w.handoverId, key(), { extra: 1 }, as(a)),
    ).rejects.toMatchObject({
      response: { code: 'INVALID_BODY' },
    });
    await controller.note(w.handoverId, key(), { text: 'internal' }, as(b));
    expect(
      await db.internalNote.count({
        where: { conversationId: w.conversationId },
      }),
    ).toBe(1);
    expect(
      await db.message.count({
        where: { conversationId: w.conversationId, authorType: 'OPERATOR' },
      }),
    ).toBe(1);
    const back = await controller.returnToBot(w.handoverId, key(), as(a));
    expect(back).toMatchObject({ status: 'ok', state: 'BOT_ACTIVE' });
    const audits = await db.auditEvent.count({
      where: { tenantId: w.tenantId, actorType: 'OPERATOR' },
    });
    expect(audits).toBeGreaterThanOrEqual(4);
  });

  it('never reaches another tenant’s handover', async () => {
    const mine = await world();
    const theirs = await world();
    const operator = await authenticate(mine.tokens[0]);
    await expect(
      controller.takeOver(theirs.handoverId, key(), as(operator)),
    ).rejects.toMatchObject({
      status: 404,
      response: { code: 'NOT_FOUND' },
    });
    await expect(
      controller.close(theirs.handoverId, key(), as(operator)),
    ).rejects.toMatchObject({
      status: 404,
    });
    expect(
      (
        await db.conversation.findFirstOrThrow({
          where: { id: theirs.conversationId },
        })
      ).state,
    ).toBe('WAITING_OPERATOR');
  });

  it('closes a conversation through the API', async () => {
    const w = await world();
    const a = await authenticate(w.tokens[0]);
    expect(await controller.close(w.handoverId, key(), as(a))).toMatchObject({
      state: 'CLOSED',
    });
    await expect(
      controller.takeOver(w.handoverId, key(), as(a)),
    ).rejects.toMatchObject({
      status: 409,
      response: { code: 'ILLEGAL_STATE' },
    });
  });
});
