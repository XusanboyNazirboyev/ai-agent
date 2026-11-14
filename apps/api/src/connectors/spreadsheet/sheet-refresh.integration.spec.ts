/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { config as loadEnv } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../generated/prisma/client.js';
import { createPostgresAdapter } from '../../persistence/postgres-adapter.js';
import type { PrismaService } from '../../persistence/prisma.service.js';
import {
  SHEET_REFRESH_EVERY_MS,
  SHEET_REFRESH_RETRY_MS,
  SheetCatalogService,
} from './sheet-catalog.service.js';
import { PrismaSheetCatalogStore } from './sheet-catalog.store.js';

loadEnv({ path: resolve(process.cwd(), '../../.env'), quiet: true });
if (process.env.TEST_POSTGRES_DATABASE !== 'agentcore_test') {
  throw new Error('Sheet refresh tests require agentcore_test');
}
const db = new PrismaClient({
  adapter: createPostgresAdapter(process.env, 'TEST_'),
});
const prisma = db as unknown as PrismaService;
const store = new PrismaSheetCatalogStore(prisma);
afterAll(async () => {
  await db.$disconnect();
});

const HEADER = 'Destination,Hotel,Nights,Price,Currency,Departure';
const csvOf = (price: string, header = HEADER) =>
  `${header}\nDubai,Rixos Sample,5,${price},USD,2026-03-14\nDubai,Atlantis Sample,7,990,USD,2026-03-21\n`;

/** A fake Google serving many sheets by id; a scan reaches every tenant's list. */
interface FakeSheet {
  text: string;
  status: number;
  type: string;
  calls: number;
}
const sheets = new Map<string, FakeSheet>();
const fetchImpl = (async (input: URL | string) => {
  const id = /\/d\/([^/]+)\//u.exec(new URL(String(input)).pathname)?.[1] ?? '';
  const sheet = sheets.get(id);
  if (!sheet) return new Response('', { status: 404 });
  sheet.calls += 1;
  return new Response(sheet.text, {
    status: sheet.status,
    headers: { 'content-type': sheet.type },
  });
}) as unknown as typeof fetch;
const service = new SheetCatalogService(prisma, store, { fetchImpl });

function newSheet(text: string): {
  id: string;
  link: string;
  state: FakeSheet;
} {
  const id = `T${randomUUID().replaceAll('-', '')}`;
  const state = { text, status: 200, type: 'text/csv', calls: 0 };
  sheets.set(id, state);
  return {
    id,
    state,
    link: `https://docs.google.com/spreadsheets/d/${id}/edit#gid=0`,
  };
}

async function world() {
  const t = await db.tenant.create({
    data: {
      slug: `refresh-${randomUUID()}`,
      name: 'Refresh fixture',
      defaultLocale: 'en',
      supportedLocales: ['en'],
      timezone: 'Asia/Tashkent',
      packKey: 'travel',
      packVersion: '1',
    },
  });
  const op = await db.operator.create({
    data: { tenantId: t.id, displayName: 'Owner', role: 'OWNER' },
  });
  return { tenantId: t.id, actor: { tenantId: t.id, operatorId: op.id } };
}

const T0 = new Date('2026-03-01T08:00:00Z');
const later = (ms: number) => new Date(T0.getTime() + ms);

async function saved(autoRefresh: boolean, text = csvOf('820')) {
  const w = await world();
  const sheet = newSheet(text);
  await service.commit(
    w.actor,
    text,
    { sourceUrl: sheet.link, autoRefresh, freshnessDays: 3 },
    null,
    T0,
  );
  return { ...w, ...sheet, service };
}

const priceOf = async (tenantId: string) =>
  (
    await db.sheetCatalogOffer.findMany({
      where: { tenantId },
      orderBy: { price: 'asc' },
    })
  ).map((o) => o.price.toString());

const codeOf = async (work: Promise<unknown>) => {
  try {
    await work;
    return 'no error';
  } catch (error) {
    return (error as { code?: string }).code ?? `other:${String(error)}`;
  }
};

describe('Google Sheets link: saving and refreshing (ADR 064 S3)', () => {
  it('saves the canonical link and the mapped headers, and reloads new prices', async () => {
    const w = await saved(true);
    const status = await w.service.status(w.tenantId, T0);
    expect(status).toMatchObject({
      sourceUrl: w.link,
      autoRefresh: true,
      refreshError: null,
    });
    expect(await priceOf(w.tenantId)).toEqual(['820', '990']);

    w.state.text = csvOf('760');
    const result = await w.service.refresh(
      w.tenantId,
      { operatorId: w.actor.operatorId },
      later(3_600_000),
    );
    expect(result).toEqual({ accepted: 2, rejected: 0 });
    expect(await priceOf(w.tenantId)).toEqual(['760', '990']);
    const audit = await db.auditEvent.findFirst({
      where: { tenantId: w.tenantId, action: 'catalog.sheet.refreshed' },
    });
    expect(audit?.actorType).toBe('OPERATOR');
    // Counts only: no price or hotel name in the audit trail.
    expect(JSON.stringify(audit?.safeInputSummary)).not.toMatch(/760|Rixos/u);
  });

  it('a file upload without a link keeps no link and no auto refresh', async () => {
    const w = await world();
    const google = { service, state: newSheet(csvOf('820')).state };
    await google.service.commit(
      w.actor,
      csvOf('820'),
      { autoRefresh: true },
      'p.csv',
      T0,
    );
    expect(await google.service.status(w.tenantId, T0)).toMatchObject({
      sourceUrl: null,
      autoRefresh: false,
    });
    expect(await codeOf(google.service.refresh(w.tenantId, null, T0))).toBe(
      'SHEET_NO_LINK',
    );
    expect(google.state.calls).toBe(0);
  });

  it('refuses a pasted address that is not a Google Sheets link', async () => {
    const w = await world();
    const google = { service, state: newSheet(csvOf('820')).state };
    expect(
      await codeOf(
        google.service.commit(
          w.actor,
          csvOf('820'),
          { sourceUrl: 'https://evil.test/x' },
          null,
          T0,
        ),
      ),
    ).toBe('SHEET_LINK_INVALID');
    expect(
      await db.sheetCatalog.count({ where: { tenantId: w.tenantId } }),
    ).toBe(0);
  });

  it('keeps the old list and says why when Google fails', async () => {
    const w = await saved(true);
    w.state.status = 500;
    expect(await codeOf(w.service.refresh(w.tenantId, null, later(1000)))).toBe(
      'SHEET_LINK_UNREACHABLE',
    );
    w.state.status = 200;
    w.state.type = 'text/html';
    expect(await codeOf(w.service.refresh(w.tenantId, null, later(2000)))).toBe(
      'SHEET_LINK_NOT_PUBLIC',
    );
    expect(await priceOf(w.tenantId)).toEqual(['820', '990']);
    expect((await w.service.status(w.tenantId, T0)).refreshError).toBe(
      'SHEET_LINK_NOT_PUBLIC',
    );
    // A good reload clears the reason.
    w.state.type = 'text/csv';
    await w.service.refresh(w.tenantId, null, later(3000));
    expect((await w.service.status(w.tenantId, T0)).refreshError).toBeNull();
  });

  it('refuses a sheet whose mapped columns moved: a shifted price column is never read', async () => {
    const w = await saved(true);
    // A new first column pushes every column one place to the right.
    w.state.text = `Note,${HEADER}\nx,Dubai,Rixos Sample,5,1,USD,2026-03-14\n`;
    expect(await codeOf(w.service.refresh(w.tenantId, null, later(1000)))).toBe(
      'SHEET_COLUMNS_CHANGED',
    );
    expect(await priceOf(w.tenantId)).toEqual(['820', '990']);
    // Same positions but a renamed header is refused too.
    w.state.text = csvOf(
      '800',
      'Destination,Hotel,Nights,Cost,Currency,Departure',
    );
    expect(await codeOf(w.service.refresh(w.tenantId, null, later(2000)))).toBe(
      'SHEET_COLUMNS_CHANGED',
    );
    expect(await priceOf(w.tenantId)).toEqual(['820', '990']);
  });

  it('refuses a sheet with no readable row and keeps the old list', async () => {
    const w = await saved(true);
    w.state.text = `${HEADER}\nDubai,Rixos Sample,5,not a price,USD,2026-03-14\n`;
    expect(await codeOf(w.service.refresh(w.tenantId, null, later(1000)))).toBe(
      'SHEET_NO_VALID_ROWS',
    );
    expect(await priceOf(w.tenantId)).toEqual(['820', '990']);
  });
});

describe('Google Sheets link: the periodic scan', () => {
  it('reloads a due list, skips fresh ones, manual lists and lists with auto refresh off', async () => {
    const due = await saved(true);
    const fresh = await saved(true);
    const off = await saved(false);
    due.state.text = csvOf('700');
    fresh.state.text = csvOf('700');
    off.state.text = csvOf('700');
    const now = later(SHEET_REFRESH_EVERY_MS + 1000);
    // `fresh` was loaded a minute ago, so it is not due.
    await db.sheetCatalog.updateMany({
      where: { tenantId: fresh.tenantId },
      data: { uploadedAt: later(SHEET_REFRESH_EVERY_MS - 60_000) },
    });
    const scanned = await due.service.scanDue(now, 1000);
    expect(scanned).toBeGreaterThanOrEqual(1);
    expect(await priceOf(due.tenantId)).toEqual(['700', '990']);
    expect(await priceOf(fresh.tenantId)).toEqual(['820', '990']);
    expect(await priceOf(off.tenantId)).toEqual(['820', '990']);
    expect(fresh.state.calls).toBe(0); // saving a file never calls Google
    expect(off.state.calls).toBe(0);
  });

  it('does not hit Google twice for the same list in one retry window', async () => {
    const w = await saved(true);
    w.state.status = 500;
    const now = later(SHEET_REFRESH_EVERY_MS + 1000);
    await w.service.scanDue(now, 1000);
    const callsAfterFirst = w.state.calls;
    expect(callsAfterFirst).toBe(1);
    // Another process runs the scan a minute later: the list was just tried.
    await w.service.scanDue(new Date(now.getTime() + 60_000), 1000);
    expect(w.state.calls).toBe(callsAfterFirst);
    // After the retry window it is tried again.
    await w.service.scanDue(
      new Date(now.getTime() + SHEET_REFRESH_RETRY_MS + 1000),
      1000,
    );
    expect(w.state.calls).toBe(callsAfterFirst + 1);
    expect(await priceOf(w.tenantId)).toEqual(['820', '990']);
  });

  it('claims a list for exactly one of two parallel scans', async () => {
    const w = await saved(true);
    const meta = (await db.sheetCatalog.findFirst({
      where: { tenantId: w.tenantId },
    }))!;
    const now = later(SHEET_REFRESH_EVERY_MS + 1000);
    const notAfter = new Date(now.getTime() - SHEET_REFRESH_RETRY_MS);
    const [a, b] = await Promise.all([
      store.claimRefresh(w.tenantId, meta.id, now, notAfter),
      store.claimRefresh(w.tenantId, meta.id, now, notAfter),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
  });

  it('a failing list never stops the others', async () => {
    const bad = await saved(true);
    const good = await saved(true);
    bad.state.status = 500;
    good.state.text = csvOf('640');
    await good.service.scanDue(later(SHEET_REFRESH_EVERY_MS + 1000), 1000);
    expect(await priceOf(good.tenantId)).toEqual(['640', '990']);
    expect(await priceOf(bad.tenantId)).toEqual(['820', '990']);
  });
});
