import { ManualLeadService } from "../leads/manual-lead.service.js";
/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { config as loadEnv } from "dotenv";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { ExecutionContext } from "@nestjs/common";
import { afterAll, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "../generated/prisma/client.js";
import { PeopleService } from "../persons/people.service.js";
import { PersonErasureService } from "../persons/person-erasure.service.js";
import { PersonMergeService } from "../persons/person-merge.service.js";
import { createPostgresAdapter } from "../persistence/postgres-adapter.js";
import type { PrismaService } from "../persistence/prisma.service.js";
import { ContactErasureService } from "../retention/contact-erasure.service.js";
import { CustomFieldsController } from "../webinbox/custom-fields.controller.js";
import { InboxReadService } from "../webinbox/inbox-read.service.js";
import { LeadPipelineController } from "../webinbox/lead-pipeline.controller.js";
import { PeopleController } from "../webinbox/people.controller.js";
import {
  SESSION_COOKIE,
  SessionGuard,
  type InboxRequest,
} from "../webinbox/session.guard.js";
import {
  DEFAULT_SESSION_POLICY,
  SessionService,
} from "../webinbox/session.service.js";
import { TagsController } from "../webinbox/tags.controller.js";
import { CustomFieldsService } from "./custom-fields.service.js";
import { TagsService } from "./tags.service.js";

loadEnv({ path: resolve(process.cwd(), "../../.env"), quiet: true });
if (process.env.TEST_POSTGRES_DATABASE !== "agentcore_test") {
  throw new Error("Tags integration tests require agentcore_test");
}
const db = new PrismaClient({
  adapter: createPostgresAdapter(process.env, "TEST_"),
});
const prisma = db as unknown as PrismaService;
afterAll(async () => {
  await db.$disconnect();
});

const sessions = new SessionService(prisma, {
  ...DEFAULT_SESSION_POLICY,
  scrypt: { N: 1024, r: 8, p: 1 },
});
const guard = new SessionGuard(sessions, {
  get: () => ["http://localhost:3000"],
} as never);
const tagsService = new TagsService(prisma);
const fieldsService = new CustomFieldsService(prisma);
const peopleService = new PeopleService(prisma);
const contactErasure = new ContactErasureService(prisma);
const tagsC = new TagsController(tagsService);
const fieldsC = new CustomFieldsController(fieldsService);
const peopleC = new PeopleController(
  peopleService,
  new PersonMergeService(prisma, peopleService),
  new PersonErasureService(prisma, contactErasure),
  prisma,
  tagsService,
  fieldsService,
);
const leadsC = new LeadPipelineController(
  prisma,
  tagsService,
  fieldsService,
  new ManualLeadService(prisma),
);
const read = new InboxReadService(prisma);

const unique = (prefix: string): string => `${prefix}-${randomUUID()}`;
type Role = "OWNER" | "ADMIN" | "OPERATOR" | "VIEWER";

interface Fixture {
  tenantId: string;
  accountId: string;
  as: Record<Role, InboxRequest>;
  operatorId: string;
}

async function signIn(tenantId: string, role: Role) {
  const operator = await db.operator.create({
    data: { tenantId, displayName: `Op ${role}`, role },
  });
  const email = `${unique("op")}@example.test`;
  await sessions.setPassword(tenantId, operator.id, email, "correct horse");
  const login = await sessions.login(email, "correct horse");
  if (!login.ok) throw new Error("login failed");
  const request = {
    method: "GET",
    headers: { cookie: `${SESSION_COOKIE}=${login.sessionToken}` },
  } as unknown as InboxRequest;
  await guard.canActivate({
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext);
  return { request, operatorId: operator.id };
}

async function fixture(): Promise<Fixture> {
  const tenant = await db.tenant.create({
    data: {
      slug: unique("tg"),
      name: "Tags fixture",
      defaultLocale: "en",
      supportedLocales: ["en"],
      timezone: "UTC",
      packKey: "test",
      packVersion: "1",
    },
  });
  const account = await db.channelAccount.create({
    data: {
      tenantId: tenant.id,
      channelType: "telegram",
      externalAccountId: unique("tg"),
      displayName: "@bot",
      status: "ACTIVE",
    },
  });
  const owner = await signIn(tenant.id, "OWNER");
  const admin = await signIn(tenant.id, "ADMIN");
  const operator = await signIn(tenant.id, "OPERATOR");
  const viewer = await signIn(tenant.id, "VIEWER");
  return {
    tenantId: tenant.id,
    accountId: account.id,
    operatorId: owner.operatorId,
    as: {
      OWNER: owner.request,
      ADMIN: admin.request,
      OPERATOR: operator.request,
      VIEWER: viewer.request,
    },
  };
}

async function person(
  f: Fixture,
  options: {
    contacts?: Array<{ deleted?: boolean }>;
    fields?: Record<string, string | number | boolean>;
    mergedInto?: string;
  } = {},
) {
  const p = await db.person.create({
    data: {
      tenantId: f.tenantId,
      displayName: "Customer",
      customFields: options.fields ?? {},
      mergedIntoId: options.mergedInto ?? null,
    },
  });
  const contacts = [];
  for (const c of options.contacts ?? [{}])
    contacts.push(
      await db.contact.create({
        data: {
          tenantId: f.tenantId,
          channelAccountId: f.accountId,
          providerUserId: unique("u"),
          name: "Customer",
          deletedAt: c.deleted ? new Date() : null,
          personId: p.id,
        },
      }),
    );
  return { person: p, contacts };
}

async function leadFor(f: Fixture, contactId: string) {
  const conversation = await db.conversation.create({
    data: {
      tenantId: f.tenantId,
      channelAccountId: f.accountId,
      contactId,
      providerChatId: unique("chat"),
      state: "BOT_ACTIVE",
    },
  });
  return db.lead.create({
    data: {
      tenantId: f.tenantId,
      contactId,
      conversationId: conversation.id,
      summary: "lead",
      idempotencyKey: unique("lead"),
    },
  });
}

const tag = (f: Fixture, name = unique("t"), color: string | null = null) =>
  db.tag.create({ data: { tenantId: f.tenantId, name, color } });
const fieldDef = (
  f: Fixture,
  key: string,
  type: "TEXT" | "NUMBER" | "DATE" | "BOOLEAN" | "SELECT",
  extra: {
    entity?: "PERSON" | "LEAD";
    options?: string[];
    position?: number;
    archived?: boolean;
  } = {},
) =>
  db.customFieldDef.create({
    data: {
      tenantId: f.tenantId,
      entity: extra.entity ?? "PERSON",
      key,
      label: key.toUpperCase(),
      type,
      options: extra.options ?? undefined,
      position: extra.position ?? 0,
      archivedAt: extra.archived ? new Date() : null,
    },
  });

const httpError = async (promise: Promise<unknown>) =>
  promise.then(
    () => {
      throw new Error("expected the call to be rejected");
    },
    (error: { getStatus(): number; getResponse(): { code?: string } }) => ({
      status: error.getStatus(),
      code: error.getResponse().code,
    }),
  );

describe("Tags CRUD and limits (ADR 053)", () => {
  it("creates, lists with usage counts, renames and archives", async () => {
    const f = await fixture();
    const created = await tagsC.create(f.as.OWNER, {
      name: "  VIP  ",
      color: "blue",
    });
    expect(created).toMatchObject({
      name: "VIP",
      color: "blue",
      usage: { people: 0, leads: 0 },
    });
    const p = await person(f);
    const lead = await leadFor(f, p.contacts[0].id);
    await peopleC.setTags(f.as.OPERATOR, p.person.id, { tagIds: [created.id] });
    await leadsC.setTags(f.as.ADMIN, lead.id, { tagIds: [created.id] });
    expect((await tagsC.list(f.as.VIEWER)).items).toEqual([
      {
        id: created.id,
        name: "VIP",
        color: "blue",
        usage: { people: 1, leads: 1 },
      },
    ]);
    const renamed = await tagsC.update(f.as.ADMIN, created.id, {
      name: "Gold",
      color: null,
    });
    expect(renamed).toMatchObject({ name: "Gold", color: null });
    await tagsC.archive(f.as.OWNER, created.id);
    expect((await tagsC.list(f.as.OWNER)).items).toEqual([]);
    expect(await db.personTag.count({ where: { tenantId: f.tenantId } })).toBe(
      0,
    );
    expect(await db.leadTag.count({ where: { tenantId: f.tenantId } })).toBe(0);
    expect((await peopleC.detail(f.as.OWNER, p.person.id)).tags).toEqual([]);
    // The name is free again after archiving.
    await tagsC.create(f.as.OWNER, { name: "vip" });
    expect(await httpError(tagsC.archive(f.as.OWNER, created.id))).toEqual({
      status: 404,
      code: "NOT_FOUND",
    });
  });

  it("refuses a duplicate name case-insensitively (TAG_EXISTS) on create and rename", async () => {
    const f = await fixture();
    await tagsC.create(f.as.OWNER, { name: "Hot" });
    expect(await httpError(tagsC.create(f.as.OWNER, { name: "HOT" }))).toEqual({
      status: 409,
      code: "TAG_EXISTS",
    });
    const other = await tagsC.create(f.as.OWNER, { name: "Cold" });
    expect(
      await httpError(tagsC.update(f.as.OWNER, other.id, { name: "hot" })),
    ).toEqual({ status: 409, code: "TAG_EXISTS" });
    // Renaming to its own name in another case is fine.
    await tagsC.update(f.as.OWNER, other.id, { name: "COLD" });
  });

  it("allows the same tag name in another tenant", async () => {
    const a = await fixture();
    const b = await fixture();
    await tagsC.create(a.as.OWNER, { name: "Shared" });
    await tagsC.create(b.as.OWNER, { name: "Shared" });
    expect((await tagsC.list(b.as.OWNER)).items).toHaveLength(1);
  });

  it("refuses the 201st active tag (TAG_LIMIT) but archived tags do not count", async () => {
    const f = await fixture();
    await db.tag.createMany({
      data: Array.from({ length: 199 }, (_, i) => ({
        tenantId: f.tenantId,
        name: `bulk ${i}`,
      })),
    });
    await db.tag.create({
      data: { tenantId: f.tenantId, name: "old", archivedAt: new Date() },
    });
    await tagsC.create(f.as.OWNER, { name: "number 200" });
    expect(
      await httpError(tagsC.create(f.as.OWNER, { name: "one more" })),
    ).toEqual({
      status: 409,
      code: "TAG_LIMIT",
    });
  });

  it("rejects an invalid body", async () => {
    const f = await fixture();
    for (const body of [
      {},
      { name: "" },
      { name: "x".repeat(41) },
      { name: "ok", color: "pink" },
      { name: "ok", extra: 1 },
    ])
      expect(await httpError(tagsC.create(f.as.OWNER, body))).toEqual({
        status: 400,
        code: "INVALID_BODY",
      });
    expect(
      await httpError(tagsC.update(f.as.OWNER, randomUUID(), {})),
    ).toMatchObject({ status: 400 });
    expect(
      await httpError(tagsC.update(f.as.OWNER, "nope", { name: "a" })),
    ).toEqual({
      status: 404,
      code: "NOT_FOUND",
    });
  });

  it("writes audit events without customer values", async () => {
    const f = await fixture();
    const t = await tagsC.create(f.as.OWNER, {
      name: "Secret name",
      color: "red",
    });
    await tagsC.update(f.as.OWNER, t.id, { name: "Other" });
    await tagsC.archive(f.as.OWNER, t.id);
    const events = await db.auditEvent.findMany({
      where: { tenantId: f.tenantId, entityType: "tag" },
      orderBy: { createdAt: "asc" },
    });
    expect(events.map((e) => e.action)).toEqual([
      "tag.created",
      "tag.updated",
      "tag.archived",
    ]);
    expect(JSON.stringify(events.map((e) => e.safeInputSummary))).not.toContain(
      "Secret",
    );
  });
});

describe("Custom field definitions (ADR 053)", () => {
  it("creates every type, orders by position, filters by entity", async () => {
    const f = await fixture();
    const text = await fieldsC.create(f.as.OWNER, {
      entity: "PERSON",
      key: "note",
      label: "Note",
      type: "TEXT",
    });
    const pick = await fieldsC.create(f.as.ADMIN, {
      entity: "PERSON",
      key: "tier",
      label: "Tier",
      type: "SELECT",
      options: [" gold ", "silver"],
    });
    await fieldsC.create(f.as.OWNER, {
      entity: "LEAD",
      key: "budget",
      label: "Budget",
      type: "NUMBER",
    });
    for (const [key, type] of [
      ["born", "DATE"],
      ["vip", "BOOLEAN"],
    ] as const)
      await fieldsC.create(f.as.OWNER, {
        entity: "PERSON",
        key,
        label: key,
        type,
      });
    expect(text.position).toBe(0);
    expect(pick).toMatchObject({ options: ["gold", "silver"], position: 1 });
    const persons = await fieldsC.list(f.as.VIEWER, { entity: "PERSON" });
    expect(persons.items.map((i) => i.key)).toEqual([
      "note",
      "tier",
      "born",
      "vip",
    ]);
    expect(
      (await fieldsC.list(f.as.OPERATOR, { entity: "LEAD" })).items,
    ).toHaveLength(1);
    expect((await fieldsC.list(f.as.OPERATOR, {})).items).toHaveLength(5);
    expect(await httpError(fieldsC.list(f.as.OWNER, { entity: "X" }))).toEqual({
      status: 400,
      code: "INVALID_QUERY",
    });
  });

  it("validates the definition body (slug, SELECT options, options on other types)", async () => {
    const f = await fixture();
    const base = { entity: "PERSON", key: "ok", label: "Ok", type: "TEXT" };
    for (const body of [
      { ...base, key: "Bad-Key" },
      { ...base, key: "1abc" },
      { ...base, key: "a".repeat(41) },
      { ...base, label: "" },
      { ...base, label: "x".repeat(81) },
      { ...base, type: "MONEY" },
      { ...base, options: ["a"] },
      { ...base, type: "SELECT" },
      { ...base, type: "SELECT", options: [] },
      { ...base, type: "SELECT", options: ["a", "a"] },
      { ...base, type: "SELECT", options: ["x".repeat(61)] },
    ])
      expect(await httpError(fieldsC.create(f.as.OWNER, body))).toEqual({
        status: 400,
        code: "INVALID_BODY",
      });
  });

  it("keeps key and type immutable; label, options and position can change", async () => {
    const f = await fixture();
    const sel = await fieldsC.create(f.as.OWNER, {
      entity: "PERSON",
      key: "tier",
      label: "Tier",
      type: "SELECT",
      options: ["a"],
    });
    const text = await fieldsC.create(f.as.OWNER, {
      entity: "PERSON",
      key: "note",
      label: "Note",
      type: "TEXT",
    });
    for (const body of [
      { key: "other" },
      { type: "TEXT" },
      { entity: "LEAD" },
      {},
    ])
      expect(await httpError(fieldsC.update(f.as.OWNER, sel.id, body))).toEqual(
        {
          status: 400,
          code: "INVALID_BODY",
        },
      );
    const updated = await fieldsC.update(f.as.ADMIN, sel.id, {
      label: "Level",
      options: ["a", "b"],
      position: 5,
    });
    expect(updated).toMatchObject({
      key: "tier",
      type: "SELECT",
      label: "Level",
      options: ["a", "b"],
      position: 5,
    });
    expect(
      await httpError(fieldsC.update(f.as.OWNER, text.id, { options: ["x"] })),
    ).toEqual({ status: 400, code: "INVALID_BODY" });
  });

  it("FIELD_KEY_TAKEN for an active key and for an archived key with another type; reactivates with the same type", async () => {
    const f = await fixture();
    const first = await fieldsC.create(f.as.OWNER, {
      entity: "PERSON",
      key: "note",
      label: "Note",
      type: "TEXT",
    });
    const again = (type: string) =>
      fieldsC.create(f.as.OWNER, {
        entity: "PERSON",
        key: "note",
        label: "N",
        type,
      });
    expect(await httpError(again("TEXT"))).toEqual({
      status: 409,
      code: "FIELD_KEY_TAKEN",
    });
    await fieldsC.archive(f.as.OWNER, first.id);
    expect(await httpError(again("NUMBER"))).toEqual({
      status: 409,
      code: "FIELD_KEY_TAKEN",
    });
    const back = await again("TEXT");
    expect(back.id).toBe(first.id);
    expect((await fieldsC.list(f.as.OWNER, {})).items).toHaveLength(1);
    // The same key may exist on the other entity.
    await fieldsC.create(f.as.OWNER, {
      entity: "LEAD",
      key: "note",
      label: "N",
      type: "NUMBER",
    });
  });

  it("refuses the 51st active definition per tenant and entity", async () => {
    const f = await fixture();
    await db.customFieldDef.createMany({
      data: Array.from({ length: 50 }, (_, i) => ({
        tenantId: f.tenantId,
        entity: "PERSON" as const,
        key: `f${i}`,
        label: `F${i}`,
        type: "TEXT" as const,
        position: i,
      })),
    });
    expect(
      await httpError(
        fieldsC.create(f.as.OWNER, {
          entity: "PERSON",
          key: "extra",
          label: "Extra",
          type: "TEXT",
        }),
      ),
    ).toEqual({ status: 409, code: "FIELD_LIMIT" });
    await fieldsC.create(f.as.OWNER, {
      entity: "LEAD",
      key: "extra",
      label: "Extra",
      type: "TEXT",
    });
  });

  it("archives a definition but keeps stored values", async () => {
    const f = await fixture();
    const d = await fieldDef(f, "note", "TEXT");
    const p = await person(f, { fields: { note: "kept" } });
    await fieldsC.archive(f.as.OWNER, d.id);
    expect(
      (await peopleC.detail(f.as.OWNER, p.person.id)).customFields,
    ).toEqual([]);
    const row = await db.person.findUniqueOrThrow({
      where: { id: p.person.id },
    });
    expect(row.customFields).toEqual({ note: "kept" });
  });

  it("audits definition changes with the key but no stored value", async () => {
    const f = await fixture();
    const d = await fieldsC.create(f.as.OWNER, {
      entity: "PERSON",
      key: "note",
      label: "Note",
      type: "TEXT",
    });
    await fieldsC.update(f.as.OWNER, d.id, { label: "Other" });
    await fieldsC.archive(f.as.OWNER, d.id);
    const events = await db.auditEvent.findMany({
      where: { tenantId: f.tenantId, entityType: "custom_field" },
      orderBy: { createdAt: "asc" },
    });
    expect(events.map((e) => e.action)).toEqual([
      "custom_field.created",
      "custom_field.updated",
      "custom_field.archived",
    ]);
  });
});

describe("Role matrix (ADR 053)", () => {
  it("everyone reads; only OWNER and ADMIN manage tags and definitions", async () => {
    const f = await fixture();
    const t = await tag(f);
    const d = await fieldDef(f, "note", "TEXT");
    for (const role of ["OWNER", "ADMIN", "OPERATOR", "VIEWER"] as const) {
      expect((await tagsC.list(f.as[role])).items).toHaveLength(1);
      expect((await fieldsC.list(f.as[role], {})).items).toHaveLength(1);
    }
    for (const role of ["OPERATOR", "VIEWER"] as const) {
      const denied = { status: 403, code: "FORBIDDEN" };
      expect(await httpError(tagsC.create(f.as[role], { name: "x" }))).toEqual(
        denied,
      );
      expect(
        await httpError(tagsC.update(f.as[role], t.id, { name: "y" })),
      ).toEqual(denied);
      expect(await httpError(tagsC.archive(f.as[role], t.id))).toEqual(denied);
      expect(
        await httpError(
          fieldsC.create(f.as[role], {
            entity: "PERSON",
            key: "k",
            label: "K",
            type: "TEXT",
          }),
        ),
      ).toEqual(denied);
      expect(
        await httpError(fieldsC.update(f.as[role], d.id, { label: "z" })),
      ).toEqual(denied);
      expect(await httpError(fieldsC.archive(f.as[role], d.id))).toEqual(
        denied,
      );
    }
  });

  it("OWNER, ADMIN and OPERATOR assign tags and values; VIEWER gets 403", async () => {
    const f = await fixture();
    const t = await tag(f);
    await fieldDef(f, "note", "TEXT");
    const p = await person(f);
    for (const role of ["OWNER", "ADMIN", "OPERATOR"] as const) {
      await peopleC.setTags(f.as[role], p.person.id, { tagIds: [t.id] });
      await peopleC.setCustomFields(f.as[role], p.person.id, {
        values: { note: role },
      });
    }
    const denied = { status: 403, code: "FORBIDDEN" };
    expect(
      await httpError(
        peopleC.setTags(f.as.VIEWER, p.person.id, { tagIds: [] }),
      ),
    ).toEqual(denied);
    expect(
      await httpError(
        peopleC.setCustomFields(f.as.VIEWER, p.person.id, {
          values: { note: "x" },
        }),
      ),
    ).toEqual(denied);
    const lead = await leadFor(f, p.contacts[0].id);
    expect(
      await httpError(leadsC.setTags(f.as.VIEWER, lead.id, { tagIds: [] })),
    ).toEqual(denied);
    expect(
      await httpError(
        leadsC.setCustomFields(f.as.VIEWER, lead.id, { values: { note: "x" } }),
      ),
    ).toEqual(denied);
  });
});

describe("Assigning tags (ADR 053)", () => {
  it("replaces the set, ignores duplicate ids and audits counts only", async () => {
    const f = await fixture();
    const [a, b, c] = [await tag(f), await tag(f), await tag(f)];
    const p = await person(f);
    await peopleC.setTags(f.as.OPERATOR, p.person.id, {
      tagIds: [a.id, b.id, a.id],
    });
    const res = await peopleC.setTags(f.as.OPERATOR, p.person.id, {
      tagIds: [b.id, c.id],
    });
    expect(res.tags.map((t) => t.id).sort()).toEqual([b.id, c.id].sort());
    expect(await db.personTag.count({ where: { personId: p.person.id } })).toBe(
      2,
    );
    await peopleC.setTags(f.as.OPERATOR, p.person.id, { tagIds: [] });
    expect((await peopleC.detail(f.as.OWNER, p.person.id)).tags).toEqual([]);
    const events = await db.auditEvent.findMany({
      where: { tenantId: f.tenantId, action: "person.tags_set" },
      orderBy: { createdAt: "asc" },
    });
    expect(events.map((e) => e.safeInputSummary)).toEqual([
      { added: 2, removed: 0, total: 2 },
      { added: 1, removed: 1, total: 2 },
      { added: 0, removed: 2, total: 0 },
    ]);
  });

  it("UNKNOWN_TAG for an unknown, archived or other-tenant tag", async () => {
    const f = await fixture();
    const other = await fixture();
    const p = await person(f);
    const archived = await db.tag.create({
      data: { tenantId: f.tenantId, name: "old", archivedAt: new Date() },
    });
    const foreign = await tag(other);
    const mine = await tag(f);
    for (const id of [randomUUID(), archived.id, foreign.id])
      expect(
        await httpError(
          peopleC.setTags(f.as.OWNER, p.person.id, { tagIds: [mine.id, id] }),
        ),
      ).toEqual({ status: 400, code: "UNKNOWN_TAG" });
    expect(await db.personTag.count({ where: { personId: p.person.id } })).toBe(
      0,
    );
    expect(
      await httpError(
        peopleC.setTags(f.as.OWNER, p.person.id, { tagIds: ["x"] }),
      ),
    ).toEqual({ status: 400, code: "INVALID_BODY" });
  });

  it("TAG_LIMIT above 20 tags per person or lead", async () => {
    const f = await fixture();
    await db.tag.createMany({
      data: Array.from({ length: 21 }, (_, i) => ({
        tenantId: f.tenantId,
        name: `t${i}`,
      })),
    });
    const ids = (
      await db.tag.findMany({ where: { tenantId: f.tenantId } })
    ).map((t) => t.id);
    const p = await person(f);
    const lead = await leadFor(f, p.contacts[0].id);
    expect(
      await httpError(
        peopleC.setTags(f.as.OWNER, p.person.id, { tagIds: ids }),
      ),
    ).toEqual({ status: 409, code: "TAG_LIMIT" });
    expect(
      await httpError(leadsC.setTags(f.as.OWNER, lead.id, { tagIds: ids })),
    ).toEqual({ status: 409, code: "TAG_LIMIT" });
    const res = await peopleC.setTags(f.as.OWNER, p.person.id, {
      tagIds: ids.slice(0, 20),
    });
    expect(res.tags).toHaveLength(20);
  });

  it("404 for an unknown, other-tenant, merged or erased person or lead", async () => {
    const f = await fixture();
    const other = await fixture();
    const t = await tag(f);
    const live = await person(f);
    const target = await person(f);
    const merged = await person(f, { mergedInto: target.person.id });
    const erased = await person(f, { contacts: [{ deleted: true }] });
    const foreign = await person(other);
    const erasedLead = await leadFor(f, erased.contacts[0].id);
    const foreignLead = await leadFor(other, foreign.contacts[0].id);
    const notFound = { status: 404, code: "NOT_FOUND" };
    for (const id of [
      randomUUID(),
      "not-a-uuid",
      merged.person.id,
      erased.person.id,
      foreign.person.id,
    ])
      expect(
        await httpError(peopleC.setTags(f.as.OWNER, id, { tagIds: [t.id] })),
      ).toEqual(notFound);
    for (const id of [randomUUID(), erasedLead.id, foreignLead.id])
      expect(
        await httpError(leadsC.setTags(f.as.OWNER, id, { tagIds: [t.id] })),
      ).toEqual(notFound);
    expect(
      await httpError(
        peopleC.setCustomFields(f.as.OWNER, foreign.person.id, {
          values: { a: 1 },
        }),
      ),
    ).toEqual(notFound);
    await peopleC.setTags(f.as.OWNER, live.person.id, { tagIds: [t.id] });
  });
});

describe("Custom field values (ADR 053)", () => {
  async function world() {
    const f = await fixture();
    await fieldDef(f, "note", "TEXT", { position: 0 });
    await fieldDef(f, "size", "NUMBER", { position: 1 });
    await fieldDef(f, "born", "DATE", { position: 2 });
    await fieldDef(f, "vip", "BOOLEAN", { position: 3 });
    await fieldDef(f, "tier", "SELECT", {
      position: 4,
      options: ["gold", "silver"],
    });
    await fieldDef(f, "old", "TEXT", { position: 5, archived: true });
    await fieldDef(f, "budget", "NUMBER", { entity: "LEAD" });
    const p = await person(f);
    const lead = await leadFor(f, p.contacts[0].id);
    return { f, p, lead };
  }
  const patch = (w: Awaited<ReturnType<typeof world>>, values: object) =>
    peopleC.setCustomFields(w.f.as.OPERATOR, w.p.person.id, { values });

  it("accepts a valid value of every type and returns all definitions in order", async () => {
    const w = await world();
    const res = await patch(w, {
      note: "hello",
      size: 12.5,
      born: "2024-02-29",
      vip: false,
      tier: "gold",
    });
    expect(res.customFields).toEqual([
      { key: "note", label: "NOTE", type: "TEXT", value: "hello" },
      { key: "size", label: "SIZE", type: "NUMBER", value: 12.5 },
      { key: "born", label: "BORN", type: "DATE", value: "2024-02-29" },
      { key: "vip", label: "VIP", type: "BOOLEAN", value: false },
      { key: "tier", label: "TIER", type: "SELECT", value: "gold" },
    ]);
  });

  it("INVALID_VALUE for every wrong value (400) and stores nothing", async () => {
    const w = await world();
    const bad: Array<Record<string, unknown>> = [
      { note: 5 },
      { note: "x".repeat(501) },
      { size: "x" },
      { size: true },
      { born: "2026-02-30" },
      { born: "12.11.2026" },
      { vip: "true" },
      { vip: 1 },
      { tier: "bronze" },
      { tier: 3 },
      { note: "fine", size: "bad" },
    ];
    for (const values of bad)
      expect(await httpError(patch(w, values))).toEqual({
        status: 400,
        code: "INVALID_VALUE",
      });
    const row = await db.person.findUniqueOrThrow({
      where: { id: w.p.person.id },
    });
    expect(row.customFields).toEqual({});
  });

  it("INVALID_BODY for a non-primitive value, an empty or missing values object", async () => {
    const w = await world();
    for (const body of [
      {},
      { values: {} },
      { values: { note: [] } },
      { values: { note: { a: 1 } } },
      { values: "x" },
    ])
      expect(
        await httpError(
          peopleC.setCustomFields(w.f.as.OWNER, w.p.person.id, body),
        ),
      ).toEqual({ status: 400, code: "INVALID_BODY" });
  });

  it("UNKNOWN_FIELD for an unknown or archived key, other entity key and prototype names", async () => {
    const w = await world();
    for (const values of [
      { nope: "x" },
      { old: "x" },
      { budget: 5 },
      { note: "ok", nope: 1 },
      { constructor: "x" },
    ])
      expect(await httpError(patch(w, values))).toEqual({
        status: 400,
        code: "UNKNOWN_FIELD",
      });
  });

  it("merges the given keys and null clears one", async () => {
    const w = await world();
    await patch(w, { note: "a", size: 1 });
    const res = await patch(w, { note: null, vip: true });
    expect(
      Object.fromEntries(res.customFields.map((c) => [c.key, c.value])),
    ).toEqual({ note: null, size: 1, born: null, vip: true, tier: null });
    const row = await db.person.findUniqueOrThrow({
      where: { id: w.p.person.id },
    });
    expect(row.customFields).toEqual({ size: 1, vip: true });
    const events = await db.auditEvent.findMany({
      where: { tenantId: w.f.tenantId, action: "person.custom_fields_set" },
      orderBy: { createdAt: "asc" },
    });
    expect(events.map((e) => e.safeInputSummary)).toEqual([
      { set: 2, cleared: 0 },
      { set: 1, cleared: 1 },
    ]);
  });

  it("keeps a stored value of an archived definition when other keys change", async () => {
    const w = await world();
    await db.person.update({
      where: { id: w.p.person.id },
      data: { customFields: { old: "legacy" } },
    });
    await patch(w, { note: "new" });
    const row = await db.person.findUniqueOrThrow({
      where: { id: w.p.person.id },
    });
    expect(row.customFields).toEqual({ old: "legacy", note: "new" });
  });

  it("validates lead values against LEAD definitions", async () => {
    const w = await world();
    const res = await leadsC.setCustomFields(w.f.as.OPERATOR, w.lead.id, {
      values: { budget: 100 },
    });
    expect(res.customFields).toEqual([
      { key: "budget", label: "BUDGET", type: "NUMBER", value: 100 },
    ]);
    expect(
      await httpError(
        leadsC.setCustomFields(w.f.as.OPERATOR, w.lead.id, {
          values: { note: "x" },
        }),
      ),
    ).toEqual({ status: 400, code: "UNKNOWN_FIELD" });
  });
});

describe("Reads and filters (ADR 053)", () => {
  it("person list items carry tags; detail carries definitions with values", async () => {
    const f = await fixture();
    const [b, a] = [await tag(f, "Beta", "green"), await tag(f, "alpha")];
    await fieldDef(f, "second", "TEXT", { position: 2 });
    await fieldDef(f, "first", "TEXT", { position: 1 });
    const p = await person(f, { fields: { second: "x" } });
    await peopleC.setTags(f.as.OWNER, p.person.id, { tagIds: [b.id, a.id] });
    const list = await peopleC.list(f.as.VIEWER, {});
    expect(list.items[0].tags).toEqual([
      { id: a.id, name: "alpha", color: null },
      { id: b.id, name: "Beta", color: "green" },
    ]);
    const detail = await peopleC.detail(f.as.VIEWER, p.person.id);
    expect(detail.customFields).toEqual([
      { key: "first", label: "FIRST", type: "TEXT", value: null },
      { key: "second", label: "SECOND", type: "TEXT", value: "x" },
    ]);
    expect(detail.tags).toHaveLength(2);
  });

  it("loads the tags of a whole page in ONE query", async () => {
    const f = await fixture();
    const t = await tag(f);
    for (let i = 0; i < 6; i++) {
      const p = await person(f);
      await peopleC.setTags(f.as.OWNER, p.person.id, { tagIds: [t.id] });
    }
    const spy = vi.spyOn(db.personTag, "findMany");
    const page = await peopleC.list(f.as.OWNER, { limit: "10" });
    expect(page.items).toHaveLength(6);
    expect(page.items.every((i) => i.tags.length === 1)).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("filters people by tagId (400 on a bad uuid) and by one custom field", async () => {
    const f = await fixture();
    const t = await tag(f);
    await fieldDef(f, "tier", "SELECT", { options: ["gold", "silver"] });
    await fieldDef(f, "vip", "BOOLEAN");
    await fieldDef(f, "size", "NUMBER");
    const a = await person(f, { fields: { tier: "gold", vip: true, size: 3 } });
    const b = await person(f, { fields: { tier: "silver", vip: false } });
    const c = await person(f);
    await peopleC.setTags(f.as.OWNER, a.person.id, { tagIds: [t.id] });
    const ids = async (query: Record<string, string>) =>
      (await peopleC.list(f.as.OWNER, query)).items.map((i) => i.id).sort();
    expect(await ids({ tagId: t.id })).toEqual([a.person.id]);
    expect(await ids({ tagId: randomUUID() })).toEqual([]);
    expect(await ids({ fieldKey: "tier", fieldValue: "silver" })).toEqual([
      b.person.id,
    ]);
    expect(await ids({ fieldKey: "vip", fieldValue: "true" })).toEqual([
      a.person.id,
    ]);
    expect(await ids({ fieldKey: "size", fieldValue: "3" })).toEqual([
      a.person.id,
    ]);
    expect(
      await ids({ tagId: t.id, fieldKey: "tier", fieldValue: "silver" }),
    ).toEqual([]);
    expect((await ids({})).sort()).toEqual(
      [a.person.id, b.person.id, c.person.id].sort(),
    );
    expect(
      await httpError(peopleC.list(f.as.OWNER, { tagId: "nope" })),
    ).toEqual({
      status: 400,
      code: "INVALID_QUERY",
    });
    expect(
      await httpError(peopleC.list(f.as.OWNER, { fieldKey: "tier" })),
    ).toEqual({ status: 400, code: "INVALID_QUERY" });
    expect(
      await httpError(
        peopleC.list(f.as.OWNER, { fieldKey: "nope", fieldValue: "x" }),
      ),
    ).toEqual({ status: 400, code: "UNKNOWN_FIELD" });
    expect(
      await httpError(
        peopleC.list(f.as.OWNER, { fieldKey: "tier", fieldValue: "bronze" }),
      ),
    ).toEqual({ status: 400, code: "INVALID_VALUE" });
  });

  it("does not leak tags or filter results across tenants", async () => {
    const a = await fixture();
    const b = await fixture();
    const t = await tag(a);
    const pa = await person(a);
    await peopleC.setTags(a.as.OWNER, pa.person.id, { tagIds: [t.id] });
    expect((await peopleC.list(b.as.OWNER, { tagId: t.id })).items).toEqual([]);
    expect((await tagsC.list(b.as.OWNER)).items).toEqual([]);
  });

  it("lead list and conversation view carry tags and custom fields; tagId filter works", async () => {
    const f = await fixture();
    const t = await tag(f, "Warm", "amber");
    await fieldDef(f, "budget", "NUMBER", { entity: "LEAD" });
    const p1 = await person(f);
    const p2 = await person(f);
    const l1 = await leadFor(f, p1.contacts[0].id);
    const l2 = await leadFor(f, p2.contacts[0].id);
    await leadsC.setTags(f.as.OPERATOR, l1.id, { tagIds: [t.id] });
    await leadsC.setCustomFields(f.as.OPERATOR, l1.id, {
      values: { budget: 7 },
    });
    const all = await leadsC.list(f.as.VIEWER, {});
    const item1 = all.items.find((i) => i.id === l1.id)!;
    const item2 = all.items.find((i) => i.id === l2.id)!;
    expect(item1.tags).toEqual([{ id: t.id, name: "Warm", color: "amber" }]);
    expect(item1.customFields).toEqual([
      { key: "budget", label: "BUDGET", type: "NUMBER", value: 7 },
    ]);
    expect(item2.tags).toEqual([]);
    expect(item2.customFields[0].value).toBeNull();
    const filtered = await leadsC.list(f.as.VIEWER, { tagId: t.id });
    expect(filtered.items.map((i) => i.id)).toEqual([l1.id]);
    const byField = await leadsC.list(f.as.VIEWER, {
      fieldKey: "budget",
      fieldValue: "7",
    });
    expect(byField.items.map((i) => i.id)).toEqual([l1.id]);
    expect(await httpError(leadsC.list(f.as.VIEWER, { tagId: "x" }))).toEqual({
      status: 400,
      code: "INVALID_QUERY",
    });
    const principal = f.as.VIEWER.principal!;
    const view = await read.view(principal, l1.conversationId);
    expect(view?.lead?.tags).toEqual([
      { id: t.id, name: "Warm", color: "amber" },
    ]);
    expect(view?.lead?.customFields[0].value).toBe(7);
  });
});

describe("Erasure clears tags and values (ADR 053)", () => {
  async function tagged(f: Fixture, contacts: number, fields = true) {
    const t = await tag(f);
    if (fields) await fieldDef(f, "note", "TEXT").catch(() => undefined);
    const p = await person(f, {
      contacts: Array.from({ length: contacts }, () => ({})),
      fields: { note: "personal text" },
    });
    await db.personTag.create({
      data: { tenantId: f.tenantId, personId: p.person.id, tagId: t.id },
    });
    return { t, p };
  }
  const state = async (personId: string) => ({
    fields: (await db.person.findUniqueOrThrow({ where: { id: personId } }))
      .customFields,
    tags: await db.personTag.count({ where: { personId } }),
  });

  it("erasing the LAST contact clears values and tag links", async () => {
    const f = await fixture();
    const { p } = await tagged(f, 2);
    await contactErasure.erase(f.tenantId, p.contacts[0].id, f.operatorId);
    expect(await state(p.person.id)).toEqual({
      fields: { note: "personal text" },
      tags: 1,
    });
    await contactErasure.erase(f.tenantId, p.contacts[1].id, f.operatorId);
    expect(await state(p.person.id)).toEqual({ fields: {}, tags: 0 });
  });

  it("erasing a whole person clears values and tag links", async () => {
    const f = await fixture();
    const { p } = await tagged(f, 2);
    await peopleC.erase(f.as.OWNER, p.person.id);
    expect(await state(p.person.id)).toEqual({ fields: {}, tags: 0 });
  });

  it("clears the merged lineage rows too", async () => {
    const f = await fixture();
    const { p: survivor } = await tagged(f, 1);
    const { p: merged } = await tagged(f, 1);
    await peopleC.merge(f.as.OWNER, merged.person.id, {
      intoId: survivor.person.id,
      reason: "same customer",
    });
    await peopleC.erase(f.as.OWNER, survivor.person.id);
    expect(await state(survivor.person.id)).toEqual({ fields: {}, tags: 0 });
    expect(await state(merged.person.id)).toEqual({ fields: {}, tags: 0 });
  });

  it("clears a merged-away copy when its own contacts are erased but the survivor lives", async () => {
    const f = await fixture();
    const { p: survivor } = await tagged(f, 1);
    const { p: merged } = await tagged(f, 1);
    await peopleC.merge(f.as.OWNER, merged.person.id, {
      intoId: survivor.person.id,
      reason: "same customer",
    });
    await contactErasure.erase(f.tenantId, merged.contacts[0].id, f.operatorId);
    expect(await state(merged.person.id)).toEqual({ fields: {}, tags: 0 });
    // The tag the survivor carried over from the erased customer is removed
    // again; only the survivor's own tag stays.
    expect((await state(survivor.person.id)).tags).toBe(1);
  });

  it("removes what a merge carried onto the survivor once the merged customer is erased; later edits stay", async () => {
    const f = await fixture();
    await fieldDef(f, "note", "TEXT").catch(() => undefined);
    await fieldDef(f, "city", "TEXT").catch(() => undefined);
    const own = await tag(f);
    const carriedTag = await tag(f);
    const survivor = await person(f, { fields: { city: "Samarkand" } });
    const source = await person(f, {
      fields: { note: "private note", city: "Tashkent" },
    });
    await db.personTag.createMany({
      data: [
        { personId: survivor.person.id, tagId: own.id },
        { personId: source.person.id, tagId: carriedTag.id },
      ].map((r) => ({ tenantId: f.tenantId, ...r })),
    });
    const res = await peopleC.merge(f.as.OWNER, source.person.id, {
      intoId: survivor.person.id,
      reason: "same customer",
    });
    // Survivor now holds the carried note and tag; the operator edits city.
    expect((await state(survivor.person.id)).fields).toEqual({
      city: "Samarkand",
      note: "private note",
    });
    await db.person.update({
      where: { id: survivor.person.id },
      data: { customFields: { city: "Bukhara", note: "edited by operator" } },
    });

    await contactErasure.erase(f.tenantId, source.contacts[0].id, f.operatorId);
    const after = await state(survivor.person.id);
    // The carried tag is gone, the survivor's own tag stays.
    expect(after.tags).toBe(1);
    // The carried note was edited since the merge, so it stays; nothing else changes.
    expect(after.fields).toEqual({
      city: "Bukhara",
      note: "edited by operator",
    });
    const merge = await db.personMerge.findUniqueOrThrow({
      where: { id: res.mergeId },
    });
    expect(merge.carried).toBeNull();

    // Unedited carried values are removed.
    const f2 = await fixture();
    await fieldDef(f2, "note", "TEXT").catch(() => undefined);
    const s2 = await person(f2, {});
    const m2 = await person(f2, { fields: { note: "private note" } });
    await peopleC.merge(f2.as.OWNER, m2.person.id, {
      intoId: s2.person.id,
      reason: "same customer",
    });
    expect((await state(s2.person.id)).fields).toEqual({
      note: "private note",
    });
    await contactErasure.erase(f2.tenantId, m2.contacts[0].id, f2.operatorId);
    expect((await state(s2.person.id)).fields).toEqual({});
  });

  it("clears the lead tags and values of an erased contact", async () => {
    const f = await fixture();
    const t = await tag(f);
    await fieldDef(f, "budget", "NUMBER", { entity: "LEAD" });
    const p = await person(f);
    const lead = await leadFor(f, p.contacts[0].id);
    await leadsC.setTags(f.as.OWNER, lead.id, { tagIds: [t.id] });
    await leadsC.setCustomFields(f.as.OWNER, lead.id, {
      values: { budget: 5 },
    });
    await contactErasure.erase(f.tenantId, p.contacts[0].id, f.operatorId);
    expect(await db.leadTag.count({ where: { leadId: lead.id } })).toBe(0);
    expect(
      (await db.lead.findUniqueOrThrow({ where: { id: lead.id } }))
        .customFields,
    ).toEqual({});
  });
});

describe("Merge carries and unmerge restores (ADR 053)", () => {
  async function pair(f: Fixture) {
    const [shared, onlySurvivor, onlySource] = [
      await tag(f),
      await tag(f),
      await tag(f),
    ];
    const survivor = await person(f, { fields: { a: "mine", b: "keep" } });
    const source = await person(f, {
      fields: { a: "theirs", c: "new", d: 3 },
    });
    await db.personTag.createMany({
      data: [
        { personId: survivor.person.id, tagId: shared.id },
        { personId: survivor.person.id, tagId: onlySurvivor.id },
        { personId: source.person.id, tagId: shared.id },
        { personId: source.person.id, tagId: onlySource.id },
      ].map((r) => ({ tenantId: f.tenantId, ...r })),
    });
    return { shared, onlySurvivor, onlySource, survivor, source };
  }
  const tagIds = async (personId: string) =>
    (await db.personTag.findMany({ where: { personId } }))
      .map((r) => r.tagId)
      .sort();

  it("survivor gets the tag union and fills only empty keys; carried is recorded", async () => {
    const f = await fixture();
    const w = await pair(f);
    const res = await peopleC.merge(f.as.ADMIN, w.source.person.id, {
      intoId: w.survivor.person.id,
      reason: "same customer",
    });
    expect(await tagIds(w.survivor.person.id)).toEqual(
      [w.shared.id, w.onlySurvivor.id, w.onlySource.id].sort(),
    );
    const row = await db.person.findUniqueOrThrow({
      where: { id: w.survivor.person.id },
    });
    expect(row.customFields).toEqual({ a: "mine", b: "keep", c: "new", d: 3 });
    const merge = await db.personMerge.findUniqueOrThrow({
      where: { id: res.mergeId },
    });
    expect(merge.carried).toEqual({
      tagIds: [w.onlySource.id],
      fields: { c: "new", d: 3 },
    });
    // The merged person is left as it was.
    expect(await tagIds(w.source.person.id)).toHaveLength(2);
  });

  it("unmerge removes exactly the carried tags and fields", async () => {
    const f = await fixture();
    const w = await pair(f);
    await peopleC.merge(f.as.ADMIN, w.source.person.id, {
      intoId: w.survivor.person.id,
      reason: "same customer",
    });
    await peopleC.unmerge(f.as.ADMIN, w.survivor.person.id);
    expect(await tagIds(w.survivor.person.id)).toEqual(
      [w.shared.id, w.onlySurvivor.id].sort(),
    );
    const row = await db.person.findUniqueOrThrow({
      where: { id: w.survivor.person.id },
    });
    expect(row.customFields).toEqual({ a: "mine", b: "keep" });
  });

  it("a field edited after the merge stays; a removed carried tag is not recreated", async () => {
    const f = await fixture();
    const w = await pair(f);
    await peopleC.merge(f.as.ADMIN, w.source.person.id, {
      intoId: w.survivor.person.id,
      reason: "same customer",
    });
    await db.person.update({
      where: { id: w.survivor.person.id },
      data: { customFields: { a: "mine", b: "keep", c: "edited later", d: 3 } },
    });
    await db.personTag.deleteMany({
      where: { personId: w.survivor.person.id, tagId: w.onlySource.id },
    });
    await peopleC.unmerge(f.as.ADMIN, w.survivor.person.id);
    const row = await db.person.findUniqueOrThrow({
      where: { id: w.survivor.person.id },
    });
    expect(row.customFields).toEqual({
      a: "mine",
      b: "keep",
      c: "edited later",
    });
    expect(await tagIds(w.survivor.person.id)).toEqual(
      [w.shared.id, w.onlySurvivor.id].sort(),
    );
  });

  it("caps the survivor at 20 tags", async () => {
    const f = await fixture();
    await db.tag.createMany({
      data: Array.from({ length: 24 }, (_, i) => ({
        tenantId: f.tenantId,
        name: `t${i}`,
      })),
    });
    const ids = (await db.tag.findMany({ where: { tenantId: f.tenantId } }))
      .map((t) => t.id)
      .sort();
    const survivor = await person(f);
    const source = await person(f);
    await db.personTag.createMany({
      data: ids.slice(0, 18).map((tagId) => ({
        tenantId: f.tenantId,
        personId: survivor.person.id,
        tagId,
      })),
    });
    await db.personTag.createMany({
      data: ids.slice(14, 24).map((tagId) => ({
        tenantId: f.tenantId,
        personId: source.person.id,
        tagId,
      })),
    });
    const res = await peopleC.merge(f.as.OWNER, source.person.id, {
      intoId: survivor.person.id,
      reason: "same customer",
    });
    expect(await tagIds(survivor.person.id)).toHaveLength(20);
    const merge = await db.personMerge.findUniqueOrThrow({
      where: { id: res.mergeId },
    });
    expect((merge.carried as { tagIds: string[] }).tagIds).toEqual(
      ids.slice(18, 20),
    );
  });
});
