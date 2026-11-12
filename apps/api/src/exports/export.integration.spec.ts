/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { config as loadEnv } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { HttpException, type ExecutionContext } from '@nestjs/common';
import { afterAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../generated/prisma/client.js';
import { createPostgresAdapter } from '../persistence/postgres-adapter.js';
import type { PrismaService } from '../persistence/prisma.service.js';
import { PeopleService } from '../persons/people.service.js';
import { ExportsController } from '../webinbox/exports.controller.js';
import {
  SESSION_COOKIE,
  SessionGuard,
  type InboxRequest,
} from '../webinbox/session.guard.js';
import {
  DEFAULT_SESSION_POLICY,
  SessionService,
} from '../webinbox/session.service.js';
import { ExportLock } from './export-lock.js';
import { ExportService } from './export.service.js';

loadEnv({ path: resolve(process.cwd(), '../../.env'), quiet: true });
if (process.env.TEST_POSTGRES_DATABASE !== 'agentcore_test') {
  throw new Error('Export integration tests require agentcore_test');
}
const db = new PrismaClient({
  adapter: createPostgresAdapter(process.env, 'TEST_'),
});
const prisma = db as unknown as PrismaService;
afterAll(async () => {
  await db.$disconnect();
});

/** In-memory stand-in for the Redis client of the lock (no Redis needed). */
class FakeRedis {
  readonly keys = new Map<string, string>();
  set(key: string, value: string, _px: 'PX', _ttl: number, _nx: 'NX') {
    if (this.keys.has(key)) return Promise.resolve(null);
    this.keys.set(key, value);
    return Promise.resolve('OK');
  }
  eval(_script: string, _n: number, key: string, value: string) {
    if (this.keys.get(key) === value) this.keys.delete(key);
    return Promise.resolve(1);
  }
  quit() {
    return Promise.resolve('OK');
  }
}
const redis = new FakeRedis();
class TestLock extends ExportLock {
  protected override connect() {
    return redis;
  }
}
const lock = new TestLock({ get: () => 'redis://unused' } as never);

const sessions = new SessionService(prisma, {
  ...DEFAULT_SESSION_POLICY,
  scrypt: { N: 1024, r: 8, p: 1 },
});
const guard = new SessionGuard(sessions, {
  get: () => ['http://localhost:3000'],
} as never);
const exportService = new ExportService(prisma, new PeopleService(prisma));
const controller = new ExportsController(lock, exportService, prisma);

const unique = (prefix: string): string => `${prefix}-${randomUUID()}`;
type Role = 'OWNER' | 'ADMIN' | 'OPERATOR' | 'VIEWER';

interface Fixture {
  tenantId: string;
  accountId: string;
  as: Record<Role, InboxRequest>;
}

async function signIn(tenantId: string, role: Role) {
  const operator = await db.operator.create({
    data: { tenantId, displayName: `Op ${role}`, role },
  });
  const email = `${unique('op')}@example.test`;
  await sessions.setPassword(tenantId, operator.id, email, 'correct horse');
  const login = await sessions.login(email, 'correct horse');
  if (!login.ok) throw new Error('login failed');
  const request = {
    method: 'GET',
    headers: { cookie: `${SESSION_COOKIE}=${login.sessionToken}` },
  } as unknown as InboxRequest;
  await guard.canActivate({
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext);
  return request;
}

async function fixture(): Promise<Fixture> {
  const tenant = await db.tenant.create({
    data: {
      slug: unique('ex'),
      name: 'Export fixture',
      defaultLocale: 'en',
      supportedLocales: ['en'],
      timezone: 'UTC',
      packKey: 'test',
      packVersion: '1',
    },
  });
  const account = await db.channelAccount.create({
    data: {
      tenantId: tenant.id,
      channelType: 'telegram',
      externalAccountId: unique('tg'),
      displayName: '@bot',
      status: 'ACTIVE',
    },
  });
  return {
    tenantId: tenant.id,
    accountId: account.id,
    as: {
      OWNER: await signIn(tenant.id, 'OWNER'),
      ADMIN: await signIn(tenant.id, 'ADMIN'),
      OPERATOR: await signIn(tenant.id, 'OPERATOR'),
      VIEWER: await signIn(tenant.id, 'VIEWER'),
    },
  };
}

async function person(
  f: Fixture,
  name: string,
  options: {
    phone?: string;
    erased?: boolean;
    mergedInto?: string;
    deleted?: boolean;
    customFields?: Record<string, string | number | boolean>;
  } = {},
) {
  const p = await db.person.create({
    data: {
      tenantId: f.tenantId,
      displayName: name,
      mergedIntoId: options.mergedInto ?? null,
      deletedAt: options.deleted ? new Date() : null,
      customFields: options.customFields ?? {},
    },
  });
  const contact = await db.contact.create({
    data: {
      tenantId: f.tenantId,
      channelAccountId: f.accountId,
      providerUserId: unique('u'),
      name,
      phone: options.phone ?? null,
      deletedAt: options.erased ? new Date() : null,
      personId: p.id,
    },
  });
  return { person: p, contact };
}

async function lead(
  f: Fixture,
  contactId: string,
  customFields: Record<string, string | number | boolean> = {},
) {
  const conversation = await db.conversation.create({
    data: {
      tenantId: f.tenantId,
      channelAccountId: f.accountId,
      contactId,
      providerChatId: unique('chat'),
      state: 'BOT_ACTIVE',
    },
  });
  return db.lead.create({
    data: {
      tenantId: f.tenantId,
      contactId,
      conversationId: conversation.id,
      summary: 'SECRET-SUMMARY-TEXT',
      idempotencyKey: unique('lead'),
      customFields,
    },
  });
}

async function tag(f: Fixture, name: string) {
  return db.tag.create({ data: { tenantId: f.tenantId, name } });
}

/** A fake ServerResponse that records what the controller writes. */
class FakeResponse extends EventEmitter {
  status = 0;
  headers: Record<string, string> = {};
  chunks: string[] = [];
  headersSent = false;
  destroyed = false;
  ended = false;
  /** Called after each write; lets a test observe the stream mid-way. */
  onWrite?: (chunk: string) => void;
  writeHead(status: number, headers: Record<string, string>) {
    this.status = status;
    this.headers = headers;
    this.headersSent = true;
    return this;
  }
  write(chunk: string) {
    this.chunks.push(chunk);
    this.onWrite?.(chunk);
    return true;
  }
  end() {
    this.ended = true;
    this.emit('close');
  }
  destroy() {
    this.destroyed = true;
    this.emit('close');
  }
  get body() {
    return this.chunks.join('');
  }
}

type Kind = 'people' | 'leads';

async function call(
  f: Fixture,
  role: Role,
  kind: Kind,
  query: Record<string, string> = {},
  res = new FakeResponse(),
) {
  const response = res as unknown as ServerResponse;
  const request = f.as[role];
  try {
    if (kind === 'people') await controller.people(request, query, response);
    else await controller.leads(request, query, response);
    return { res, error: undefined as HttpException | undefined };
  } catch (e) {
    return { res, error: e as HttpException };
  }
}

const codeOf = (e: HttpException | undefined) =>
  (e?.getResponse() as { code?: string } | undefined)?.code;

/** Splits CSV text into rows of cells (handles quoted fields). */
function parse(csv: string): string[][] {
  const text = csv.replace(/^﻿/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\r' && text[i + 1] === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      i++;
    } else cell += c;
  }
  return rows;
}

const names = (csv: string) =>
  parse(csv)
    .slice(1)
    .map((r) => r[1]);

describe('CSV export: roles', () => {
  it.each(['OWNER', 'ADMIN'] as const)('%s gets both files', async (role) => {
    const f = await fixture();
    const { contact } = await person(f, 'Ada');
    await lead(f, contact.id);
    for (const kind of ['people', 'leads'] as const) {
      const { res, error } = await call(f, role, kind);
      expect(error).toBeUndefined();
      expect(res.status).toBe(200);
    }
  });

  it.each(['OPERATOR', 'VIEWER'] as const)(
    '%s gets 403 FORBIDDEN for people and leads and nothing is written',
    async (role) => {
      const f = await fixture();
      for (const kind of ['people', 'leads'] as const) {
        const { res, error } = await call(f, role, kind);
        expect(error?.getStatus()).toBe(403);
        expect(codeOf(error)).toBe('FORBIDDEN');
        expect(res.headersSent).toBe(false);
      }
      expect(
        await db.auditEvent.count({
          where: { tenantId: f.tenantId, entityType: 'export' },
        }),
      ).toBe(0);
    },
  );
});

describe('CSV export: response and content', () => {
  it('sends text/csv, an attachment filename, a BOM, CRLF and the columns', async () => {
    const f = await fixture();
    await person(f, 'Ada Lovelace', { phone: '+998901112233' });
    const { res } = await call(f, 'OWNER', 'people');
    expect(res.headers['Content-Type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['Content-Disposition']).toMatch(
      /^attachment; filename="people-\d{8}\.csv"$/,
    );
    expect(res.body.charCodeAt(0)).toBe(0xfeff);
    expect(res.body).toContain('\r\n');
    const [header, row] = parse(res.body);
    expect(header!.slice(0, 11)).toEqual([
      'person_id',
      'name',
      'phone',
      'channels',
      'contacts',
      'conversations',
      'leads',
      'last_activity_at',
      'marketing_opt_out',
      'created_at',
      'tags',
    ]);
    expect(row![1]).toBe('Ada Lovelace');
    expect(row![2]).toBe('+998901112233');
    expect(row![3]).toBe('telegram');
    expect(row![4]).toBe('1');
    expect(res.ended).toBe(true);
  });

  it('writes the lead columns without the summary', async () => {
    const f = await fixture();
    const { contact } = await person(f, 'Ada');
    await lead(f, contact.id);
    const { res } = await call(f, 'ADMIN', 'leads');
    const [header, row] = parse(res.body);
    expect(header!.slice(0, 9)).toEqual([
      'lead_id',
      'person_id',
      'contact_name',
      'stage',
      'score',
      'status',
      'created_at',
      'updated_at',
      'tags',
    ]);
    expect(res.body).not.toContain('SECRET-SUMMARY-TEXT');
    expect(res.headers['Content-Disposition']).toMatch(/leads-\d{8}\.csv/);
    expect(row![2]).toBe('Ada');
  });

  it('writes the header only for an empty tenant', async () => {
    const f = await fixture();
    const { res } = await call(f, 'OWNER', 'people');
    expect(parse(res.body)).toHaveLength(1);
  });

  it('adds one column per active custom field in position order, typed', async () => {
    const f = await fixture();
    await db.customFieldDef.createMany({
      data: [
        {
          tenantId: f.tenantId,
          entity: 'PERSON',
          key: 'b_age',
          label: 'Age',
          type: 'NUMBER',
          position: 2,
        },
        {
          tenantId: f.tenantId,
          entity: 'PERSON',
          key: 'a_note',
          label: 'Note',
          type: 'TEXT',
          position: 1,
        },
        {
          tenantId: f.tenantId,
          entity: 'PERSON',
          key: 'c_old',
          label: 'Old',
          type: 'TEXT',
          position: 3,
          archivedAt: new Date(),
        },
      ],
    });
    await person(f, 'Ada', { customFields: { a_note: '=cmd', b_age: -4 } });
    const { res } = await call(f, 'OWNER', 'people');
    const [header, row] = parse(res.body);
    expect(header!.slice(11)).toEqual(['Note', 'Age']);
    expect(row!.slice(11)).toEqual(["'=cmd", '-4']);
  });
});

describe('CSV export: visibility and tenant scope', () => {
  it('never exports erased, merged-away or deleted persons', async () => {
    const f = await fixture();
    const keep = await person(f, 'Keep');
    await person(f, 'Erased', { erased: true });
    await person(f, 'Merged', { mergedInto: keep.person.id });
    await person(f, 'Deleted', { deleted: true });
    const { res } = await call(f, 'OWNER', 'people');
    expect(names(res.body)).toEqual(['Keep']);
  });

  it('never exports leads of erased contacts or merged-away persons', async () => {
    const f = await fixture();
    const keep = await person(f, 'Keep');
    const erased = await person(f, 'Erased', { erased: true });
    const merged = await person(f, 'Merged', { mergedInto: keep.person.id });
    await lead(f, keep.contact.id);
    await lead(f, erased.contact.id);
    await lead(f, merged.contact.id);
    const { res } = await call(f, 'OWNER', 'leads');
    expect(
      parse(res.body)
        .slice(1)
        .map((r) => r[2]),
    ).toEqual(['Keep']);
  });

  it('exports only the caller tenant', async () => {
    const a = await fixture();
    const b = await fixture();
    await person(a, 'Tenant A person');
    const other = await person(b, 'Tenant B person');
    await lead(b, other.contact.id);
    const people = await call(a, 'OWNER', 'people');
    expect(names(people.res.body)).toEqual(['Tenant A person']);
    const leads = await call(a, 'OWNER', 'leads');
    expect(parse(leads.res.body)).toHaveLength(1);
  });

  it('ignores a tagId of another tenant (no rows, no leak)', async () => {
    const a = await fixture();
    const b = await fixture();
    await person(a, 'Ada');
    const foreign = await tag(b, 'Foreign');
    const { res } = await call(a, 'OWNER', 'people', { tagId: foreign.id });
    expect(names(res.body)).toEqual([]);
  });
});

describe('CSV export: filters', () => {
  it('filters people by search, tag and custom field', async () => {
    const f = await fixture();
    await db.customFieldDef.create({
      data: {
        tenantId: f.tenantId,
        entity: 'PERSON',
        key: 'city',
        label: 'City',
        type: 'TEXT',
      },
    });
    const ada = await person(f, 'Ada', { customFields: { city: 'Tashkent' } });
    await person(f, 'Bob', { customFields: { city: 'Samarkand' } });
    const vip = await tag(f, 'VIP');
    await db.personTag.create({
      data: { tenantId: f.tenantId, personId: ada.person.id, tagId: vip.id },
    });
    const q = await call(f, 'OWNER', 'people', { q: 'bo' });
    expect(names(q.res.body)).toEqual(['Bob']);
    const t = await call(f, 'OWNER', 'people', { tagId: vip.id });
    expect(names(t.res.body)).toEqual(['Ada']);
    expect(parse(t.res.body)[1]![10]).toBe('VIP');
    const c = await call(f, 'OWNER', 'people', {
      fieldKey: 'city',
      fieldValue: 'Samarkand',
    });
    expect(names(c.res.body)).toEqual(['Bob']);
  });

  it('filters leads by score, tag and custom field', async () => {
    const f = await fixture();
    await db.customFieldDef.create({
      data: {
        tenantId: f.tenantId,
        entity: 'LEAD',
        key: 'source',
        label: 'Source',
        type: 'TEXT',
      },
    });
    const a = await person(f, 'Ada');
    const b = await person(f, 'Bob');
    const la = await lead(f, a.contact.id, { source: 'ads' });
    await lead(f, b.contact.id, { source: 'web' });
    await db.lead.update({ where: { id: la.id }, data: { score: 'HOT' } });
    const vip = await tag(f, 'VIP');
    await db.leadTag.create({
      data: { tenantId: f.tenantId, leadId: la.id, tagId: vip.id },
    });
    const col = (csv: string) =>
      parse(csv)
        .slice(1)
        .map((r) => r[2]);
    expect(
      col((await call(f, 'OWNER', 'leads', { score: 'HOT' })).res.body),
    ).toEqual(['Ada']);
    expect(
      col((await call(f, 'OWNER', 'leads', { tagId: vip.id })).res.body),
    ).toEqual(['Ada']);
    expect(
      col(
        (
          await call(f, 'OWNER', 'leads', {
            fieldKey: 'source',
            fieldValue: 'web',
          })
        ).res.body,
      ),
    ).toEqual(['Bob']);
  });

  it.each([
    ['people', { tagId: 'not-a-uuid' }],
    ['people', { fieldKey: 'city' }],
    ['leads', { score: 'LUKEWARM' }],
    ['leads', { stage: 'nope' }],
  ] as const)(
    'rejects invalid %s query %j with 400 INVALID_QUERY',
    async (kind, query) => {
      const f = await fixture();
      const { res, error } = await call(f, 'OWNER', kind, { ...query });
      expect(error?.getStatus()).toBe(400);
      expect(codeOf(error)).toBe('INVALID_QUERY');
      expect(res.headersSent).toBe(false);
    },
  );
});

describe('CSV export: formula injection end to end', () => {
  it('neutralises names, phones, tag names and custom field values', async () => {
    const f = await fixture();
    await db.customFieldDef.create({
      data: {
        tenantId: f.tenantId,
        entity: 'PERSON',
        key: 'note',
        label: 'Note',
        type: 'TEXT',
      },
    });
    const p = await person(f, '=HYPERLINK("http://x.invalid")', {
      phone: '+1+2',
      customFields: { note: '@SUM(A1)' },
    });
    const evil = await tag(f, '-cmd|calc');
    await db.personTag.create({
      data: { tenantId: f.tenantId, personId: p.person.id, tagId: evil.id },
    });
    const { res } = await call(f, 'OWNER', 'people');
    const row = parse(res.body)[1]!;
    expect(row[1]).toBe(`'=HYPERLINK("http://x.invalid")`);
    expect(row[2]).toBe("'+1+2");
    expect(row[10]).toBe("'-cmd|calc");
    expect(row[11]).toBe("'@SUM(A1)");
  });

  it('neutralises a real-looking international phone number too', async () => {
    const f = await fixture();
    await person(f, 'Ada', { phone: '+998901112233' });
    const { res } = await call(f, 'OWNER', 'people');
    expect(parse(res.body)[1]![2]).toBe("'+998901112233");
  });
});

describe('CSV export: limits, lock, audit', () => {
  it('answers 413 EXPORT_TOO_LARGE before any byte when over the lowered limit', async () => {
    const f = await fixture();
    await person(f, 'One');
    await person(f, 'Two');
    await person(f, 'Three');
    const old = exportService.rowLimit;
    exportService.rowLimit = 2;
    try {
      const { res, error } = await call(f, 'OWNER', 'people');
      expect(error?.getStatus()).toBe(413);
      expect(codeOf(error)).toBe('EXPORT_TOO_LARGE');
      expect(res.headersSent).toBe(false);
      expect(res.chunks).toHaveLength(0);
      // The lock was released by the failed export.
      expect(redis.keys.size).toBe(0);
      const ok = await call(f, 'OWNER', 'people', { q: 'One' });
      expect(ok.error).toBeUndefined();
    } finally {
      exportService.rowLimit = old;
    }
  });

  it('answers 429 EXPORT_IN_PROGRESS while another export holds the lock', async () => {
    const f = await fixture();
    const release = await lock.acquire(f.tenantId);
    const blocked = await call(f, 'OWNER', 'people');
    expect(blocked.error?.getStatus()).toBe(429);
    expect(codeOf(blocked.error)).toBe('EXPORT_IN_PROGRESS');
    expect(blocked.res.headersSent).toBe(false);
    // Another tenant is not blocked.
    const g = await fixture();
    expect((await call(g, 'OWNER', 'people')).error).toBeUndefined();
    await release();
    expect((await call(f, 'OWNER', 'leads')).error).toBeUndefined();
  });

  it('releases the lock after a success', async () => {
    const f = await fixture();
    await call(f, 'OWNER', 'people');
    expect(redis.keys.size).toBe(0);
    expect((await call(f, 'OWNER', 'people')).error).toBeUndefined();
  });

  it('releases the lock and destroys the stream after an error mid-stream', async () => {
    const f = await fixture();
    await person(f, 'Ada');
    const res = new FakeResponse();
    const original = exportService.pageSize;
    const failing = new Error('boom');
    // The first write succeeds (headers sent); the audit insert then fails.
    const audit = prisma.auditEvent.create.bind(prisma.auditEvent);
    (prisma.auditEvent as { create: unknown }).create = () => {
      throw failing;
    };
    try {
      const { error } = await call(f, 'OWNER', 'people', {}, res);
      expect(error).toBeUndefined(); // no error response after headers
      expect(res.headersSent).toBe(true);
      expect(res.destroyed).toBe(true);
      expect(res.ended).toBe(false);
      expect(res.body).not.toContain('boom');
    } finally {
      (prisma.auditEvent as { create: unknown }).create = audit;
      exportService.pageSize = original;
    }
    expect(redis.keys.size).toBe(0);
  });

  it('stops reading and releases the lock when the client disconnects', async () => {
    const f = await fixture();
    for (let i = 0; i < 5; i++) await person(f, `P${i}`);
    const original = exportService.pageSize;
    exportService.pageSize = 2;
    const res = new FakeResponse();
    res.onWrite = () => res.destroy(); // client goes away after the first page
    try {
      await call(f, 'OWNER', 'people', {}, res);
    } finally {
      exportService.pageSize = original;
    }
    expect(res.chunks).toHaveLength(1);
    expect(redis.keys.size).toBe(0);
    expect(
      await db.auditEvent.count({
        where: { tenantId: f.tenantId, entityType: 'export' },
      }),
    ).toBe(0);
  });

  it('streams in several pages: the first bytes arrive before the last page', async () => {
    const f = await fixture();
    for (let i = 0; i < 5; i++) await person(f, `P${i}`);
    const original = exportService.pageSize;
    exportService.pageSize = 2;
    const res = new FakeResponse();
    try {
      await call(f, 'OWNER', 'people', {}, res);
    } finally {
      exportService.pageSize = original;
    }
    expect(res.chunks).toHaveLength(3);
    expect(res.chunks[0]!.charCodeAt(0)).toBe(0xfeff);
    expect(names(res.body).sort()).toEqual(['P0', 'P1', 'P2', 'P3', 'P4']);
  });

  it('writes an audit row with counts and filter names, never values', async () => {
    const f = await fixture();
    await person(f, 'Secret Name', { phone: '+998900001111' });
    const vip = await tag(f, 'VIP');
    await call(f, 'ADMIN', 'people', { q: 'Secret', tagId: vip.id });
    await call(f, 'OWNER', 'leads', { score: 'HOT' });
    const rows = await db.auditEvent.findMany({
      where: { tenantId: f.tenantId, entityType: 'export' },
      orderBy: { createdAt: 'asc' },
    });
    expect(rows.map((r) => r.action)).toEqual([
      'export.people',
      'export.leads',
    ]);
    expect(rows[0]!.safeInputSummary).toEqual({
      rows: 0,
      filters: { q: true, tagId: vip.id },
    });
    expect(rows[1]!.safeInputSummary).toEqual({
      rows: 0,
      filters: { score: 'HOT' },
    });
    expect(JSON.stringify(rows)).not.toContain('Secret');
    expect(JSON.stringify(rows)).not.toContain('998900001111');
    expect(rows[0]!.actorType).toBe('OPERATOR');
  });
});
