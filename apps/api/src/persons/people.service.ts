import { Injectable } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../persistence/prisma.service.js';
import { describeFields } from '../tags/custom-field-values.js';
import type { FieldFilter } from '../tags/field-filter.js';
import { activeFieldDefs, tagsOfPersons } from '../tags/tag-reads.js';
import {
  assemblePersonItem,
  sortContactsOldestFirst,
  type ContactActivity,
  type PersonContactRow,
  type PersonDetail,
  type PersonItem,
} from './person-view.js';
import {
  PHONE_KEY_SQL,
  buildDuplicateGroups,
  canUnmerge,
} from './person-merge.js';

const DETAIL_CAP = 20;

/** Persons that can be shown: live, not merged away, with a live contact. */
function visiblePerson(tenantId: string): Prisma.PersonWhereInput {
  return {
    tenantId,
    deletedAt: null,
    mergedIntoId: null,
    contacts: { some: { deletedAt: null } },
  };
}

/**
 * Read side of the People API (ADR 052 slice B). Tenant id always comes from
 * the caller's session principal. Erased contacts are never read into a
 * result. The related reads are batched per page (no N+1).
 */
@Injectable()
export class PeopleService {
  constructor(private readonly prisma: PrismaService) {}

  async list(
    tenantId: string,
    params: {
      q?: string;
      cursor?: string;
      limit: number;
      tagId?: string;
      field?: FieldFilter;
    },
  ): Promise<{ items: PersonItem[]; nextCursor: string | null }> {
    const { q, cursor, limit, tagId, field } = params;
    const rows = await this.prisma.person.findMany({
      where: {
        ...visiblePerson(tenantId),
        ...(cursor ? { id: { lt: cursor } } : {}),
        ...(tagId ? { tags: { some: { tenantId, tagId } } } : {}),
        ...(field
          ? { customFields: { path: [field.key], equals: field.value } }
          : {}),
        ...(q
          ? {
              OR: [
                { displayName: { contains: q, mode: 'insensitive' } },
                {
                  contacts: {
                    some: {
                      deletedAt: null,
                      OR: [
                        { name: { contains: q, mode: 'insensitive' } },
                        { phone: { contains: q } },
                      ],
                    },
                  },
                },
              ],
            }
          : {}),
      },
      // Ids are time-ordered (uuid v7): newest first and a stable keyset.
      orderBy: { id: 'desc' },
      take: limit + 1,
      select: {
        id: true,
        displayName: true,
        createdAt: true,
        contacts: {
          where: { deletedAt: null },
          select: contactSelect,
        },
      },
    });
    const page = rows.slice(0, limit);
    const contactIds = page.flatMap((p) => p.contacts.map((c) => c.id));
    const [activity, tags] = await Promise.all([
      this.activity(tenantId, contactIds),
      tagsOfPersons(
        this.prisma,
        tenantId,
        page.map((p) => p.id),
      ),
    ]);
    return {
      items: page.map((p) =>
        assemblePersonItem(
          p,
          p.contacts.map(toContactRow),
          activity,
          tags.get(p.id),
        ),
      ),
      nextCursor: rows.length > limit ? page[page.length - 1].id : null,
    };
  }

  /** List items of the visible persons among `ids`, in the order of `ids`. */
  async itemsByIds(tenantId: string, ids: string[]): Promise<PersonItem[]> {
    if (ids.length === 0) return [];
    const rows = await this.prisma.person.findMany({
      where: { ...visiblePerson(tenantId), id: { in: ids } },
      select: {
        id: true,
        displayName: true,
        createdAt: true,
        contacts: { where: { deletedAt: null }, select: contactSelect },
      },
    });
    const [activity, tags] = await Promise.all([
      this.activity(
        tenantId,
        rows.flatMap((p) => p.contacts.map((c) => c.id)),
      ),
      tagsOfPersons(
        this.prisma,
        tenantId,
        rows.map((p) => p.id),
      ),
    ]);
    const byId = new Map(
      rows.map((p) => [
        p.id,
        assemblePersonItem(
          p,
          p.contacts.map(toContactRow),
          activity,
          tags.get(p.id),
        ),
      ]),
    );
    return ids.flatMap((id) => byId.get(id) ?? []);
  }

  /** Persons sharing a phone key with `personId` (null = person not visible). */
  async duplicatesOf(
    tenantId: string,
    personId: string,
  ): Promise<PersonItem[] | null> {
    const visible = await this.prisma.person.count({
      where: { ...visiblePerson(tenantId), id: personId },
    });
    if (visible === 0) return null;
    const rows = await this.prisma.$queryRawUnsafe<Array<{ id: string }>>(
      `WITH mine AS (
         SELECT DISTINCT ${PHONE_KEY_SQL('c.phone')} AS key
         FROM contacts c
         WHERE c.tenant_id = $1::uuid AND c.person_id = $2::uuid
           AND c.deleted_at IS NULL AND c.phone IS NOT NULL
       )
       SELECT DISTINCT p.id::text AS id
       FROM contacts c
       JOIN persons p ON p.tenant_id = c.tenant_id AND p.id = c.person_id
       JOIN mine ON mine.key = ${PHONE_KEY_SQL('c.phone')}
       WHERE c.tenant_id = $1::uuid AND c.deleted_at IS NULL
         AND c.phone IS NOT NULL AND p.deleted_at IS NULL
         AND p.merged_into_id IS NULL AND p.id <> $2::uuid
       ORDER BY id DESC LIMIT 10`,
      tenantId,
      personId,
    );
    return this.itemsByIds(
      tenantId,
      rows.map((r) => r.id),
    );
  }

  /** Tenant-wide duplicate groups by phone key (at most 50, computed on read). */
  async duplicateGroups(
    tenantId: string,
  ): Promise<Array<{ reason: 'PHONE'; persons: PersonItem[] }>> {
    const rows = await this.prisma.$queryRawUnsafe<
      Array<{ key: string; person_id: string }>
    >(
      `WITH k AS (
         SELECT DISTINCT ${PHONE_KEY_SQL('c.phone')} AS key, c.person_id::text AS person_id
         FROM contacts c
         JOIN persons p ON p.tenant_id = c.tenant_id AND p.id = c.person_id
         WHERE c.tenant_id = $1::uuid AND c.deleted_at IS NULL
           AND c.phone IS NOT NULL AND p.deleted_at IS NULL
           AND p.merged_into_id IS NULL
       ), top AS (
         SELECT key FROM k WHERE key IS NOT NULL
         GROUP BY key HAVING count(*) > 1
         ORDER BY max(person_id) DESC LIMIT 50
       )
       SELECT k.key, k.person_id FROM k JOIN top ON top.key = k.key`,
      tenantId,
    );
    const groups = buildDuplicateGroups(
      rows.map((r) => ({ key: r.key, personId: r.person_id })),
    );
    const items = await this.itemsByIds(tenantId, [...new Set(groups.flat())]);
    const byId = new Map(items.map((i) => [i.id, i]));
    return groups
      .map((ids) => ({
        reason: 'PHONE' as const,
        persons: ids.flatMap((id) => byId.get(id) ?? []),
      }))
      .filter((g) => g.persons.length >= 2);
  }

  /** null = not found (unknown, other tenant, merged, or all contacts erased). */
  async detail(tenantId: string, id: string): Promise<PersonDetail | null> {
    const person = await this.prisma.person.findFirst({
      where: { ...visiblePerson(tenantId), id },
      select: {
        id: true,
        displayName: true,
        createdAt: true,
        customFields: true,
        contacts: { where: { deletedAt: null }, select: contactSelect },
      },
    });
    if (!person) return null;
    const contacts = sortContactsOldestFirst(person.contacts.map(toContactRow));
    const contactIds = contacts.map((c) => c.id);
    const [activity, conversations, leads, tags, defs] = await Promise.all([
      this.activity(tenantId, contactIds),
      this.prisma.conversation.findMany({
        where: { tenantId, contactId: { in: contactIds } },
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        take: DETAIL_CAP,
        select: {
          id: true,
          contactId: true,
          state: true,
          updatedAt: true,
          channelAccount: { select: { channelType: true } },
        },
      }),
      this.prisma.lead.findMany({
        where: { tenantId, contactId: { in: contactIds } },
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        take: DETAIL_CAP,
        select: {
          id: true,
          contactId: true,
          status: true,
          score: true,
          updatedAt: true,
          pipelineStage: { select: { name: true } },
        },
      }),
      tagsOfPersons(this.prisma, tenantId, [id]),
      activeFieldDefs(this.prisma, tenantId, 'PERSON'),
    ]);
    const item = assemblePersonItem(person, contacts, activity, tags.get(id));
    return {
      ...item,
      customFields: describeFields(defs, person.customFields),
      lastMerge: await this.lastMerge(tenantId, id),
      contacts: contacts.map((c) => ({
        id: c.id,
        channelType: c.channelType,
        channelName: c.channelName,
        name: c.name,
        phone: c.phone,
        language: c.language,
        consentStatus: c.consentStatus,
        marketingOptOut: c.marketingOptOut,
        createdAt: c.createdAt.toISOString(),
      })),
      conversations: conversations.map((c) => ({
        id: c.id,
        contactId: c.contactId,
        channelType: c.channelAccount.channelType,
        state: c.state,
        updatedAt: c.updatedAt.toISOString(),
      })),
      leads: leads.map((l) => ({
        id: l.id,
        contactId: l.contactId,
        status: l.status,
        score: l.score,
        stageName: l.pipelineStage?.name ?? null,
        updatedAt: l.updatedAt.toISOString(),
      })),
    };
  }

  /** The survivor's latest un-undone merge, only while it can be undone. */
  private async lastMerge(
    tenantId: string,
    survivorId: string,
  ): Promise<PersonDetail['lastMerge']> {
    const merge = await this.prisma.personMerge.findFirst({
      where: { tenantId, survivorId, undoneAt: null },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    if (!merge) return null;
    const [survivor, mergedPerson, contacts] = await Promise.all([
      this.prisma.person.findFirst({
        where: { tenantId, id: survivorId },
        select: { id: true, mergedIntoId: true, deletedAt: true },
      }),
      this.prisma.person.findFirst({
        where: { tenantId, id: merge.mergedId },
        select: { mergedIntoId: true },
      }),
      this.prisma.contact.findMany({
        where: { tenantId, id: { in: merge.contactIds } },
        select: { id: true, personId: true, deletedAt: true },
      }),
    ]);
    if (
      !survivor ||
      !canUnmerge({
        survivor,
        merge: { mergedId: merge.mergedId, contactIds: merge.contactIds },
        mergedPerson,
        contacts,
      })
    )
      return null;
    return {
      id: merge.id,
      mergedAt: merge.createdAt.toISOString(),
      contacts: merge.contactIds.length,
    };
  }

  /** Per-contact counts and newest conversation, in three batched reads. */
  private async activity(
    tenantId: string,
    contactIds: string[],
  ): Promise<Map<string, ContactActivity>> {
    const result = new Map<string, ContactActivity>();
    if (contactIds.length === 0) return result;
    const [conversations, leads] = await Promise.all([
      this.prisma.conversation.groupBy({
        by: ['contactId'],
        where: { tenantId, contactId: { in: contactIds } },
        _count: { _all: true },
        _max: { updatedAt: true },
      }),
      this.prisma.lead.groupBy({
        by: ['contactId'],
        where: { tenantId, contactId: { in: contactIds } },
        _count: { _all: true },
      }),
    ]);
    const newest = conversations.filter((g) => g._max.updatedAt !== null);
    const newestRows = newest.length
      ? await this.prisma.conversation.findMany({
          where: {
            tenantId,
            OR: newest.map((g) => ({
              contactId: g.contactId,
              updatedAt: g._max.updatedAt as Date,
            })),
          },
          orderBy: { id: 'desc' },
          select: { id: true, contactId: true, updatedAt: true },
        })
      : [];
    for (const id of contactIds)
      result.set(id, { conversationCount: 0, leadCount: 0, last: null });
    for (const g of conversations) {
      const entry = result.get(g.contactId);
      if (!entry) continue;
      entry.conversationCount = g._count._all;
      // First match is the highest id among ties (ordered id desc).
      const row = newestRows.find(
        (r) =>
          r.contactId === g.contactId &&
          r.updatedAt.getTime() === g._max.updatedAt?.getTime(),
      );
      entry.last = row ? { id: row.id, updatedAt: row.updatedAt } : null;
    }
    for (const g of leads) {
      const entry = result.get(g.contactId);
      if (entry) entry.leadCount = g._count._all;
    }
    return result;
  }
}

const contactSelect = {
  id: true,
  name: true,
  phone: true,
  language: true,
  consentStatus: true,
  marketingOptOut: true,
  createdAt: true,
  channelAccount: { select: { channelType: true, displayName: true } },
} as const;

function toContactRow(c: {
  id: string;
  name: string | null;
  phone: string | null;
  language: string | null;
  consentStatus: 'UNKNOWN' | 'GRANTED' | 'REVOKED';
  marketingOptOut: boolean;
  createdAt: Date;
  channelAccount: { channelType: string; displayName: string | null };
}): PersonContactRow {
  return {
    id: c.id,
    channelType: c.channelAccount.channelType,
    channelName: c.channelAccount.displayName,
    name: c.name,
    phone: c.phone,
    language: c.language,
    consentStatus: c.consentStatus,
    marketingOptOut: c.marketingOptOut,
    createdAt: c.createdAt,
  };
}
