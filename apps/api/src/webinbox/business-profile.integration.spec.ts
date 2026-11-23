/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { config as loadEnv } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { PrismaService } from '../persistence/prisma.service.js';
import {
  appClient,
  ownerClient,
  tenantScoped,
} from '../persistence/testing/test-clients.js';
import { businessProfileOf } from '../agent/business-profile.js';
import { BusinessProfileController } from './business-profile.controller.js';

loadEnv({ path: resolve(process.cwd(), '../../.env'), quiet: true });
if (process.env.TEST_POSTGRES_DATABASE !== 'agentcore_test')
  throw new Error('Business profile tests require agentcore_test');
const db = ownerClient();
const app = appClient();
const controller = tenantScoped(
  new BusinessProfileController(app as unknown as PrismaService),
);
afterAll(async () => {
  await Promise.all([db.$disconnect(), app.$disconnect()]);
});

type Role = 'OWNER' | 'ADMIN' | 'OPERATOR' | 'VIEWER';

async function world() {
  const id = randomUUID();
  const t = await db.tenant.create({
    data: {
      slug: `profile-${id}`,
      name: 'Old name',
      defaultLocale: 'uz-Latn',
      supportedLocales: ['uz-Latn'],
      timezone: 'Asia/Tashkent',
      packKey: 'travel',
      packVersion: '1',
      config: { billing: { required: true } },
    },
  });
  const ops = {} as Record<Role, string>;
  for (const role of ['OWNER', 'ADMIN', 'OPERATOR', 'VIEWER'] as Role[])
    ops[role] = (
      await db.operator.create({
        data: { tenantId: t.id, displayName: role, role },
      })
    ).id;
  const as = (role: Role) =>
    ({
      principal: {
        tenantId: t.id,
        operatorId: ops[role],
        role,
        sessionId: 's',
      },
    }) as never;
  return { tenantId: t.id, as };
}

const status = async (work: () => Promise<unknown>) => {
  try {
    await work();
    return 200;
  } catch (error) {
    return (error as { status?: number }).status ?? 500;
  }
};

const body = {
  name: ' Sayohat  Tour ',
  address: 'Toshkent, Amir Temur ko‘chasi 1',
  phone: '+998 90 123 45 67',
  hours: '',
  website: 'https://sayohat.example',
};

describe('business profile (owner 2026-11-23)', () => {
  it('managers save it, everyone reads it, the bot gets only filled fields, the audit holds no values', async () => {
    const w = await world();
    for (const role of ['OPERATOR', 'VIEWER'] as const)
      expect(await status(() => controller.put(w.as(role), body))).toBe(403);
    expect(
      await status(() =>
        controller.put(w.as('OWNER'), { ...body, website: 'javascript:x' }),
      ),
    ).toBe(400);
    expect(
      await status(() => controller.put(w.as('OWNER'), { ...body, name: 'a' })),
    ).toBe(400);
    const saved = await controller.put(w.as('ADMIN'), body);
    expect(saved).toEqual({ ...body, name: 'Sayohat Tour' });
    expect(await controller.get(w.as('VIEWER'))).toEqual(saved);
    const tenant = await db.tenant.findUniqueOrThrow({
      where: { id: w.tenantId },
    });
    // Other config keys survive the save.
    expect(tenant.config).toMatchObject({ billing: { required: true } });
    expect(businessProfileOf(tenant)).toEqual({
      name: 'Sayohat Tour',
      address: body.address,
      phone: body.phone,
      website: body.website,
    });
    const audit = await db.auditEvent.findFirstOrThrow({
      where: { tenantId: w.tenantId, action: 'tenant.profile.updated' },
    });
    expect(audit.safeInputSummary).toEqual({
      filled: 'name,address,phone,website',
    });
    expect(JSON.stringify(audit.safeInputSummary)).not.toContain('998');
  });
});
