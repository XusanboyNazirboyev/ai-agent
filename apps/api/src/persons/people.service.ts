import { Injectable } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../persistence/prisma.service.js';
import {
  assemblePersonItem,
  sortContactsOldestFirst,
  type ContactActivity,
  type PersonContactRow,
  type PersonDetail,
  type PersonItem,
} from './person-view.js';

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
    params: { q?: string; cursor?: string; limit: number },
  ): Promise<{ items: PersonItem[]; nextCursor: string | null }> {
    const { q, cursor, limit } = params;
    const rows = await this.prisma.person.findMany({
      where: {
        ...visiblePerson(tenantId),
        ...(cursor ? { id: { lt: cursor } } : {}),
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
    const activity = await this.activity(tenantId, contactIds);
    return {
      items: page.map((p) =>
        assemblePersonItem(p, p.contacts.map(toContactRow), activity),
      ),
      nextCursor: rows.length > limit ? page[page.length - 1].id : null,
    };
  }

  /** null = not found (unknown, other tenant, merged, or all contacts erased). */
  async detail(tenantId: string, id: string): Promise<PersonDetail | null> {
    const person = await this.prisma.person.findFirst({
      where: { ...visiblePerson(tenantId), id },
      select: {
        id: true,
        displayName: true,
        createdAt: true,
        contacts: { where: { deletedAt: null }, select: contactSelect },
      },
    });
    if (!person) return null;
    const contacts = sortContactsOldestFirst(person.contacts.map(toContactRow));
    const contactIds = contacts.map((c) => c.id);
    const [activity, conversations, leads] = await Promise.all([
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
    ]);
    const item = assemblePersonItem(person, contacts, activity);
    return {
      ...item,
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
