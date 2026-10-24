import { Injectable } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../persistence/prisma.service.js';
import type { InboxPrincipal } from './session.service.js';

export type InboxScope = 'waiting' | 'mine' | 'all' | 'closed';

export interface ConversationListItem {
  readonly id: string;
  readonly state: string;
  readonly contactName: string | null;
  readonly language: string | null;
  readonly leadScore: string | null;
  readonly assignedOperatorId: string | null;
  readonly waitingSince: string | null;
  readonly slaDueAt: string | null;
  readonly updatedAt: string;
}

export interface ConversationView {
  readonly conversation: {
    id: string;
    state: string;
    assignedOperatorId: string | null;
    language: string | null;
    script: string | null;
    version: number;
  };
  readonly contact: {
    name: string | null;
    phone: string | null;
    language: string | null;
    script: string | null;
  };
  readonly handover: {
    id: string;
    reasonCode: string;
    status: string;
    summary: unknown;
    slaDueAt: Date | null;
    openedAt: Date;
    takenAt: Date | null;
  } | null;
  readonly lead: {
    id: string;
    score: string;
    status: string;
    summary: string;
  } | null;
  readonly messages: readonly {
    id: string;
    authorType: string;
    direction: string;
    type: string;
    text: string;
    deliveryState: string;
    createdAt: Date;
  }[];
  readonly shownOffers: readonly {
    id: string;
    messageId: string;
    offerRef: string;
    facts: unknown;
    shownAt: Date;
  }[];
  readonly quotes: readonly {
    id: string;
    amount: string;
    currency: string;
    validUntil: Date | null;
    shownInMessageId: string | null;
  }[];
  readonly slots: unknown;
  readonly notes: readonly {
    id: string;
    operatorId: string;
    text: string;
    createdAt: Date;
  }[];
}

const MAX_PAGE = 50;

interface Cursor {
  readonly t: string;
  readonly id: string;
}

function encode(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

function decode(value: string | undefined): Cursor | undefined {
  if (!value || value.length > 300) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    return typeof parsed.t === 'string' &&
      typeof parsed.id === 'string' &&
      !Number.isNaN(Date.parse(parsed.t))
      ? { t: parsed.t, id: parsed.id }
      : undefined;
  } catch {
    return undefined;
  }
}

/** Read side of the inbox. Every query is scoped by the session's tenant. */
@Injectable()
export class InboxReadService {
  constructor(private readonly prisma: PrismaService) {}

  async list(
    principal: InboxPrincipal,
    options: {
      scope: InboxScope;
      cursor?: string;
      limit?: number;
      q?: string;
      language?: string;
      leadScore?: 'HOT' | 'WARM' | 'COLD';
    },
  ): Promise<{ items: ConversationListItem[]; nextCursor: string | null }> {
    const limit = Math.min(Math.max(options.limit ?? 25, 1), MAX_PAGE);
    const cursor = decode(options.cursor);
    const where: Prisma.ConversationWhereInput = {
      tenantId: principal.tenantId,
      ...(options.scope === 'waiting' ? { state: 'WAITING_OPERATOR' } : {}),
      ...(options.scope === 'mine'
        ? {
            state: 'OPERATOR_ACTIVE',
            assignedOperatorId: principal.operatorId,
          }
        : {}),
      ...(options.scope === 'closed' ? { state: 'CLOSED' } : {}),
      ...(options.language ? { language: options.language } : {}),
      ...(options.leadScore
        ? { leads: { some: { score: options.leadScore } } }
        : {}),
      ...(options.q
        ? {
            OR: [
              {
                contact: {
                  name: {
                    contains: options.q.slice(0, 80),
                    mode: 'insensitive',
                  },
                },
              },
              { contact: { phone: { contains: options.q.slice(0, 40) } } },
              {
                messages: {
                  some: {
                    tenantId: principal.tenantId,
                    text: {
                      contains: options.q.slice(0, 80),
                      mode: 'insensitive',
                    },
                  },
                },
              },
            ],
          }
        : {}),
      ...(cursor
        ? {
            AND: [
              {
                OR: [
                  { updatedAt: { lt: new Date(cursor.t) } },
                  { updatedAt: new Date(cursor.t), id: { lt: cursor.id } },
                ],
              },
            ],
          }
        : {}),
    };
    const rows = await this.prisma.conversation.findMany({
      where,
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      include: {
        contact: { select: { name: true } },
        leads: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { score: true },
        },
        handovers: {
          where: { status: { in: ['OPEN', 'TAKEN'] } },
          orderBy: { openedAt: 'asc' },
          take: 1,
          select: { openedAt: true, slaDueAt: true },
        },
      },
    });
    const page = rows.slice(0, limit);
    const items = page.map((row) => ({
      id: row.id,
      state: row.state,
      contactName: row.contact.name,
      language: row.language,
      leadScore: row.leads[0]?.score ?? null,
      assignedOperatorId: row.assignedOperatorId,
      waitingSince: row.handovers[0]?.openedAt.toISOString() ?? null,
      slaDueAt: row.handovers[0]?.slaDueAt?.toISOString() ?? null,
      updatedAt: row.updatedAt.toISOString(),
    }));
    // The default "waiting" view shows the longest wait first.
    if (options.scope === 'waiting')
      items.sort((a, b) =>
        (a.waitingSince ?? a.updatedAt).localeCompare(
          b.waitingSince ?? b.updatedAt,
        ),
      );
    const last = page.at(-1);
    return {
      items,
      nextCursor:
        rows.length > limit && last
          ? encode({ t: last.updatedAt.toISOString(), id: last.id })
          : null,
    };
  }

  /** Timeline and panels of one conversation; undefined when not in the tenant. */
  async view(
    principal: InboxPrincipal,
    conversationId: string,
  ): Promise<ConversationView | undefined> {
    const conversation = await this.prisma.conversation.findFirst({
      where: { tenantId: principal.tenantId, id: conversationId },
      include: {
        contact: {
          select: { name: true, phone: true, language: true, script: true },
        },
        handovers: {
          orderBy: { openedAt: 'desc' },
          take: 1,
          select: {
            id: true,
            reasonCode: true,
            status: true,
            summary: true,
            slaDueAt: true,
            openedAt: true,
            takenAt: true,
          },
        },
        leads: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { id: true, score: true, status: true, summary: true },
        },
      },
    });
    if (!conversation) return undefined;
    const [messages, notes, shownOffers, quotes, slots] = await Promise.all([
      this.prisma.message.findMany({
        where: { tenantId: principal.tenantId, conversationId },
        orderBy: { sequence: 'asc' },
        take: 500,
        select: {
          id: true,
          authorType: true,
          direction: true,
          type: true,
          text: true,
          deliveryState: true,
          createdAt: true,
        },
      }),
      this.prisma.internalNote.findMany({
        where: { tenantId: principal.tenantId, conversationId },
        orderBy: { createdAt: 'asc' },
        take: 200,
        select: { id: true, operatorId: true, text: true, createdAt: true },
      }),
      this.prisma.shownOffer.findMany({
        where: { tenantId: principal.tenantId, conversationId },
        orderBy: { shownAt: 'asc' },
        take: 100,
        select: {
          id: true,
          messageId: true,
          offerRef: true,
          facts: true,
          shownAt: true,
        },
      }),
      this.prisma.quote.findMany({
        where: { tenantId: principal.tenantId, conversationId },
        orderBy: { createdAt: 'asc' },
        take: 100,
        select: {
          id: true,
          amount: true,
          currency: true,
          validUntil: true,
          shownInMessageId: true,
        },
      }),
      this.prisma.conversationSlots.findFirst({
        where: { tenantId: principal.tenantId, conversationId },
        orderBy: { version: 'desc' },
        select: { slots: true },
      }),
    ]);
    return {
      conversation: {
        id: conversation.id,
        state: conversation.state,
        assignedOperatorId: conversation.assignedOperatorId,
        language: conversation.language,
        script: conversation.script,
        version: conversation.version,
      },
      contact: conversation.contact,
      handover: conversation.handovers[0] ?? null,
      lead: conversation.leads[0] ?? null,
      messages,
      notes,
      shownOffers,
      quotes: quotes.map((quote) => ({
        ...quote,
        amount: quote.amount.toString(),
      })),
      slots: slots?.slots ?? null,
    };
  }
}
