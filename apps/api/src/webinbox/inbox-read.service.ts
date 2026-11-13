import { Injectable } from "@nestjs/common";
import { MANUAL_CHANNEL_TYPE } from "../leads/manual-lead-rules.js";
import { Prisma } from "../generated/prisma/client.js";
import { PrismaService } from "../persistence/prisma.service.js";
import { describeFields } from "../tags/custom-field-values.js";
import {
  activeFieldDefs,
  tagsOfLeads,
  type TagView,
} from "../tags/tag-reads.js";
import type { InboxPrincipal } from "./session.service.js";

export type InboxScope = "waiting" | "mine" | "all" | "closed";

export interface ConversationListItem {
  readonly id: string;
  readonly state: string;
  readonly contactName: string | null;
  readonly language: string | null;
  readonly leadScore: string | null;
  readonly leadStatus: string | null;
  /** The score was set by an operator (ADR 037). */
  readonly leadScoreSetByOperator: boolean;
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
    scoreSetByOperator: boolean;
    crmSyncStatus: string;
    /** Active tags and custom field values (ADR 053). */
    tags: TagView[];
    customFields: ReturnType<typeof describeFields>;
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
  /** Business actions of the conversation (ADR 024). Values only while UNCERTAIN. */
  readonly actions: readonly {
    id: string;
    actionKey: string;
    status: string;
    createdAt: Date;
    outcomeAt: Date | null;
    externalId: string | null;
    errorCode: string | null;
    payload: unknown;
  }[];
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
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decode(value: string | undefined): Cursor | undefined {
  if (!value || value.length > 300) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    return typeof parsed.t === "string" &&
      typeof parsed.id === "string" &&
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
      leadScore?: "HOT" | "WARM" | "COLD";
      leadStatus?: "NEW" | "IN_PROGRESS" | "WON" | "LOST";
    },
  ): Promise<{ items: ConversationListItem[]; nextCursor: string | null }> {
    const limit = Math.min(Math.max(options.limit ?? 25, 1), MAX_PAGE);
    const cursor = decode(options.cursor);
    const where: Prisma.ConversationWhereInput = {
      tenantId: principal.tenantId,
      // ADR 061: the empty conversation of a lead added by hand is no inbox row.
      channelAccount: { channelType: { not: MANUAL_CHANNEL_TYPE } },
      ...(options.scope === "waiting" ? { state: "WAITING_OPERATOR" } : {}),
      ...(options.scope === "mine"
        ? {
            state: "OPERATOR_ACTIVE",
            assignedOperatorId: principal.operatorId,
          }
        : {}),
      ...(options.scope === "closed" ? { state: "CLOSED" } : {}),
      ...(options.language ? { language: options.language } : {}),
      ...(options.leadScore || options.leadStatus
        ? {
            leads: {
              some: {
                ...(options.leadScore ? { score: options.leadScore } : {}),
                ...(options.leadStatus ? { status: options.leadStatus } : {}),
              },
            },
          }
        : {}),
      ...(options.q
        ? {
            OR: [
              {
                contact: {
                  name: {
                    contains: options.q.slice(0, 80),
                    mode: "insensitive",
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
                      mode: "insensitive",
                    },
                  },
                },
              },
            ],
          }
        : {}),
      ...(cursor && options.scope !== "waiting"
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
    if (options.scope === "waiting") {
      // The waiting queue is ordered and paginated in PostgreSQL. Sorting only
      // the current Prisma page would miss older handovers on later pages.
      const filters = [
        Prisma.sql`c.tenant_id = ${principal.tenantId}::uuid`,
        Prisma.sql`c.state = 'WAITING_OPERATOR'`,
      ];
      if (options.language)
        filters.push(Prisma.sql`c.language = ${options.language}`);
      if (options.leadScore || options.leadStatus) {
        filters.push(Prisma.sql`EXISTS (
          SELECT 1
          FROM leads l
          WHERE l.tenant_id = c.tenant_id
            AND l.conversation_id = c.id
            ${options.leadScore ? Prisma.sql`AND l.score::text = ${options.leadScore}` : Prisma.empty}
            ${options.leadStatus ? Prisma.sql`AND l.status::text = ${options.leadStatus}` : Prisma.empty}
        )`);
      }
      if (options.q) {
        // LIKE wildcards in the search text are literals, as with Prisma's
        // `contains`.
        const like = (text: string): string =>
          `%${text.replace(/[\\%_]/g, "\\$&")}%`;
        const nameQuery = like(options.q.slice(0, 80));
        const phoneQuery = like(options.q.slice(0, 40));
        filters.push(Prisma.sql`(
          ct.name ILIKE ${nameQuery}
          OR ct.phone LIKE ${phoneQuery}
          OR EXISTS (
            SELECT 1
            FROM messages m
            WHERE m.tenant_id = c.tenant_id
              AND m.conversation_id = c.id
              AND m.text ILIKE ${nameQuery}
          )
        )`);
      }
      const candidates = await this.prisma.$queryRaw<
        { id: string; sortAt: Date }[]
      >(Prisma.sql`
        WITH waiting_candidates AS (
          SELECT
            c.id,
            -- Milliseconds: the cursor round-trips through a JS Date, which
            -- cannot hold PostgreSQL's microseconds (a sub-millisecond tail
            -- would make the last row of a page reappear on the next one).
            date_trunc('milliseconds', COALESCE(MIN(h.opened_at), c.updated_at)) AS "sortAt"
          FROM conversations c
          LEFT JOIN handovers h
            ON h.tenant_id = c.tenant_id
            AND h.conversation_id = c.id
            AND h.status IN ('OPEN', 'TAKEN')
          LEFT JOIN contacts ct
            ON ct.tenant_id = c.tenant_id
            AND ct.id = c.contact_id
          WHERE ${Prisma.join(filters, " AND ")}
          GROUP BY c.id, c.updated_at
        )
        SELECT id, "sortAt"
        FROM waiting_candidates
        ${
          cursor
            ? Prisma.sql`WHERE (
              "sortAt" > ${new Date(cursor.t)}
              OR ("sortAt" = ${new Date(cursor.t)} AND id::text > ${cursor.id})
            )`
            : Prisma.empty
        }
        ORDER BY "sortAt" ASC, id::text ASC
        LIMIT ${limit + 1}
      `);
      const page = candidates.slice(0, limit);
      const rows = page.length
        ? await this.prisma.conversation.findMany({
            where: {
              tenantId: principal.tenantId,
              state: "WAITING_OPERATOR",
              id: { in: page.map((candidate) => candidate.id) },
            },
            include: {
              contact: { select: { name: true } },
              leads: {
                orderBy: { createdAt: "desc" },
                take: 1,
                select: {
                  score: true,
                  status: true,
                  scoreSetByOperator: true,
                },
              },
              handovers: {
                where: { status: { in: ["OPEN", "TAKEN"] } },
                orderBy: { openedAt: "asc" },
                take: 1,
                select: { openedAt: true, slaDueAt: true },
              },
            },
          })
        : [];
      const byId = new Map(rows.map((row) => [row.id, row]));
      const items = page.flatMap((candidate) => {
        const row = byId.get(candidate.id);
        if (!row) return [];
        return [
          {
            id: row.id,
            state: row.state,
            contactName: row.contact.name,
            language: row.language,
            leadScore: row.leads[0]?.score ?? null,
            leadStatus: row.leads[0]?.status ?? null,
            leadScoreSetByOperator: row.leads[0]?.scoreSetByOperator ?? false,
            assignedOperatorId: row.assignedOperatorId,
            waitingSince: row.handovers[0]?.openedAt.toISOString() ?? null,
            slaDueAt: row.handovers[0]?.slaDueAt?.toISOString() ?? null,
            updatedAt: row.updatedAt.toISOString(),
          },
        ];
      });
      const last = page.at(-1);
      return {
        items,
        nextCursor:
          candidates.length > limit && last
            ? encode({ t: last.sortAt.toISOString(), id: last.id })
            : null,
      };
    }

    const rows = await this.prisma.conversation.findMany({
      where,
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      include: {
        contact: { select: { name: true } },
        leads: {
          orderBy: { createdAt: "desc" },
          take: 1,
          select: { score: true, status: true, scoreSetByOperator: true },
        },
        handovers: {
          where: { status: { in: ["OPEN", "TAKEN"] } },
          orderBy: { openedAt: "asc" },
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
      leadStatus: row.leads[0]?.status ?? null,
      leadScoreSetByOperator: row.leads[0]?.scoreSetByOperator ?? false,
      assignedOperatorId: row.assignedOperatorId,
      waitingSince: row.handovers[0]?.openedAt.toISOString() ?? null,
      slaDueAt: row.handovers[0]?.slaDueAt?.toISOString() ?? null,
      updatedAt: row.updatedAt.toISOString(),
    }));
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
          orderBy: { openedAt: "desc" },
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
          orderBy: { createdAt: "desc" },
          take: 1,
          select: {
            id: true,
            score: true,
            scoreSetByOperator: true,
            status: true,
            summary: true,
            crmSyncStatus: true,
            customFields: true,
          },
        },
      },
    });
    if (!conversation) return undefined;
    const lead = conversation.leads[0] ?? null;
    const [leadTags, leadDefs] = lead
      ? await Promise.all([
          tagsOfLeads(this.prisma, principal.tenantId, [lead.id]),
          activeFieldDefs(this.prisma, principal.tenantId, "LEAD"),
        ])
      : [new Map<string, TagView[]>(), []];
    const [messages, notes, shownOffers, quotes, slots, actions] =
      await Promise.all([
        this.prisma.message.findMany({
          where: { tenantId: principal.tenantId, conversationId },
          // Fetch the newest page, then reverse it below for chronological display.
          orderBy: { sequence: "desc" },
          take: 500,
          select: {
            id: true,
            authorType: true,
            direction: true,
            type: true,
            text: true,
            voiceStatus: true,
            deliveryState: true,
            createdAt: true,
          },
        }),
        this.prisma.internalNote.findMany({
          where: { tenantId: principal.tenantId, conversationId },
          orderBy: { createdAt: "asc" },
          take: 200,
          select: { id: true, operatorId: true, text: true, createdAt: true },
        }),
        this.prisma.shownOffer.findMany({
          where: { tenantId: principal.tenantId, conversationId },
          orderBy: { shownAt: "asc" },
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
          orderBy: { createdAt: "asc" },
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
          orderBy: { version: "desc" },
          select: { slots: true },
        }),
        this.prisma.actionProposal.findMany({
          where: { tenantId: principal.tenantId, conversationId },
          orderBy: { createdAt: "asc" },
          take: 50,
          select: {
            id: true,
            actionKey: true,
            status: true,
            createdAt: true,
            outcomeAt: true,
            externalId: true,
            errorCode: true,
            payload: true,
          },
        }),
      ]);
    // The database query selects the newest 500 messages. The UI timeline
    // consumes them oldest-to-newest so scrolling and reply context stay stable.
    messages.reverse();
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
      lead: lead
        ? {
            id: lead.id,
            score: lead.score,
            status: lead.status,
            summary: lead.summary,
            scoreSetByOperator: lead.scoreSetByOperator,
            crmSyncStatus: lead.crmSyncStatus,
            tags: leadTags.get(lead.id) ?? [],
            customFields: describeFields(leadDefs, lead.customFields),
          }
        : null,
      messages,
      notes,
      shownOffers,
      quotes: quotes.map((quote) => ({
        ...quote,
        amount: quote.amount.toString(),
      })),
      slots: slots?.slots ?? null,
      // Customer values are shown only while a person must check the outcome.
      actions: actions.map((row) => ({
        ...row,
        payload: row.status === "UNCERTAIN" ? row.payload : null,
      })),
    };
  }
}
