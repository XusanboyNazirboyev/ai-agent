/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { config as loadEnv } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  appClient,
  ownerClient,
  tenantScoped,
} from '../persistence/testing/test-clients.js';
import type { PrismaService } from '../persistence/prisma.service.js';
import { LeadImportController } from './lead-import.controller.js';
import { ensureLeadStages } from './lead-stage.util.js';
import { ManualLeadService } from './manual-lead.service.js';

loadEnv({ path: resolve(process.cwd(), '../../.env'), quiet: true });
if (process.env.TEST_POSTGRES_DATABASE !== 'agentcore_test') {
  throw new Error('Lead import integration tests require agentcore_test');
}
const db = ownerClient();
const app = appClient();
const prisma = app as unknown as PrismaService;
afterAll(async () => {
  await Promise.all([db.$disconnect(), app.$disconnect()]);
});
const api = tenantScoped(
  new LeadImportController(prisma, new ManualLeadService(prisma)),
);

type Role = 'OWNER' | 'ADMIN' | 'OPERATOR' | 'VIEWER';
const ROLES: Role[] = ['OWNER', 'ADMIN', 'OPERATOR', 'VIEWER'];
const unique = (p: string) => `${p}-${randomUUID()}`;
const request = (tenantId: string, operatorId: string, role: Role) =>
  ({
    principal: { tenantId, operatorId, role, sessionId: randomUUID() },
  }) as never;

async function world() {
  const tenant = await db.tenant.create({
    data: {
      slug: unique('li'),
      name: 'Import fixture',
      defaultLocale: 'en',
      supportedLocales: ['en'],
      timezone: 'UTC',
      packKey: 'test',
      packVersion: '1',
    },
  });
  await db.$transaction((tx) => ensureLeadStages(tx, tenant.id));
  const pipeline = await db.pipeline.findFirstOrThrow({
    where: { tenantId: tenant.id, isDefault: true, archivedAt: null },
  });
  const as = {} as Record<Role, never>;
  for (const role of ROLES) {
    const op = await db.operator.create({
      data: { tenantId: tenant.id, displayName: `Op ${role}`, role },
    });
    as[role] = request(tenant.id, op.id, role);
  }
  return { tenantId: tenant.id, pipelineId: pipeline.id, as };
}

const failure = (p: Promise<unknown>) =>
  p.then(
    () => undefined,
    (e: { getStatus(): number; getResponse(): Record<string, unknown> }) => ({
      status: e.getStatus(),
      code: e.getResponse().code,
    }),
  );

describe('POST /api/v1/leads/import (ADR 077)', () => {
  it('creates valid rows, skips invalid and duplicate ones, audits counts only', async () => {
    const w = await world();
    const first = await api.import(w.as.OWNER, {
      pipelineId: w.pipelineId,
      rows: [{ name: 'Ali', phone: '+998901112233', note: 'secret note' }],
    });
    expect(first).toEqual({ created: 1, skipped: [] });

    const res = await api.import(w.as.ADMIN, {
      pipelineId: w.pipelineId,
      rows: [
        {
          name: 'Bek',
          phone: '+998 90 555 44 33',
          amount: '100',
          currency: 'USD',
        },
        { name: '', phone: '+998901234567' },
        { name: 'Bad phone', phone: 'abc' },
        { name: 'Ali again', phone: '90 111 22 33' },
        { name: 'Bek again', phone: '+998905554433' },
        { name: 'No phone one' },
        { name: 'No phone two' },
      ],
    });
    expect(res.created).toBe(3);
    expect(res.skipped).toEqual([
      { row: 1, code: 'INVALID_VALUE' },
      { row: 2, code: 'INVALID_VALUE' },
      { row: 3, code: 'DUPLICATE' },
      { row: 4, code: 'DUPLICATE' },
    ]);

    const leads = await db.lead.findMany({
      where: { tenantId: w.tenantId },
      select: { source: true, amount: true, summary: true, pipelineId: true },
    });
    expect(leads).toHaveLength(4);
    expect(leads.every((l) => l.source === 'import')).toBe(true);
    expect(leads.every((l) => l.pipelineId === w.pipelineId)).toBe(true);

    const audits = await db.auditEvent.findMany({
      where: { tenantId: w.tenantId, action: 'lead.imported' },
    });
    expect(audits).toHaveLength(2);
    const text = JSON.stringify(audits.map((a) => a.safeInputSummary));
    expect(text).not.toMatch(/Ali|Bek|998|secret/);
    expect(audits[1].safeInputSummary).toMatchObject({ rows: 7, created: 3 });
  });

  it('keeps an explicit source and rejects a non-open stage', async () => {
    const w = await world();
    await api.import(w.as.OWNER, {
      pipelineId: w.pipelineId,
      rows: [{ name: 'Src', source: 'fair' }],
    });
    expect(
      (await db.lead.findFirstOrThrow({ where: { tenantId: w.tenantId } }))
        .source,
    ).toBe('fair');
    const closed = await db.leadStage.findFirstOrThrow({
      where: { tenantId: w.tenantId, pipelineId: w.pipelineId, kind: 'WON' },
    });
    const err = await failure(
      api.import(w.as.OWNER, {
        pipelineId: w.pipelineId,
        stageId: closed.id,
        rows: [{ name: 'x' }],
      }),
    );
    expect(err?.status).toBe(400);
  });

  it('is OWNER/ADMIN only', async () => {
    const w = await world();
    for (const role of ['OPERATOR', 'VIEWER'] as const) {
      const err = await failure(
        api.import(w.as[role], {
          pipelineId: w.pipelineId,
          rows: [{ name: 'x' }],
        }),
      );
      expect(err?.status).toBe(403);
    }
    expect(await db.lead.count({ where: { tenantId: w.tenantId } })).toBe(0);
  });

  it('answers 404 for the pipeline of another tenant', async () => {
    const a = await world();
    const b = await world();
    const err = await failure(
      api.import(a.as.OWNER, {
        pipelineId: b.pipelineId,
        rows: [{ name: 'x' }],
      }),
    );
    expect(err?.status).toBe(404);
    expect(await db.lead.count({ where: { tenantId: b.tenantId } })).toBe(0);
  });

  it('rejects an empty body, more than 200 rows and unknown keys', async () => {
    const w = await world();
    const rows = Array.from({ length: 201 }, (_, i) => ({ name: `n${i}` }));
    for (const body of [
      { pipelineId: w.pipelineId, rows },
      { pipelineId: w.pipelineId, rows: [] },
      { pipelineId: 'nope', rows: [{ name: 'x' }] },
    ]) {
      expect((await failure(api.import(w.as.OWNER, body)))?.status).toBe(400);
    }
    expect(await db.lead.count({ where: { tenantId: w.tenantId } })).toBe(0);
  });
});
