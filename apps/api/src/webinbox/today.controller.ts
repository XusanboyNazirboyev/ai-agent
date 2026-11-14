import { Controller, Get, Inject, Req, UseGuards } from '@nestjs/common';
import { PrismaService } from '../persistence/prisma.service.js';
import { SessionGuard, type InboxRequest } from './session.guard.js';

/** What a new workspace still has to do; shown to OWNER and ADMIN only. */
export interface TodayChecklist {
  /** A messenger account is connected (a test account does not count). */
  channelConnected: boolean;
  /** Prices or knowledge the assistant can answer from. */
  hasContent: boolean;
  /** Someone besides the first person can sign in or was invited. */
  teamInvited: boolean;
  /** An operator group receives the "needs an operator" alerts. */
  operatorGroup: boolean;
}

export interface TodaySummary {
  /** Customers waiting for a person, and how many are past the reply deadline. */
  waiting: { total: number; overdue: number };
  /** Leads created in the last 24 hours (archived ones excluded). */
  newLeads: number;
  checklist: TodayChecklist | null;
}

const DAY_MS = 24 * 3_600_000;

/**
 * The numbers of the "Today" page (A4 of the UX review): counts only, from the
 * session's tenant; no customer text. Every role may read the counts; the
 * getting-started checklist is for OWNER and ADMIN.
 */
@Controller('api/v1/today')
@UseGuards(SessionGuard)
export class TodayController {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  @Get()
  async summary(@Req() request: InboxRequest): Promise<TodaySummary> {
    const { tenantId, role } = request.principal!;
    const now = new Date();
    const [total, overdue, newLeads] = await Promise.all([
      this.prisma.conversation.count({
        where: { tenantId, state: 'WAITING_OPERATOR' },
      }),
      this.prisma.handover.count({
        where: { tenantId, status: 'OPEN', slaDueAt: { lt: now } },
      }),
      this.prisma.lead.count({
        where: {
          tenantId,
          archivedAt: null,
          createdAt: { gte: new Date(now.getTime() - DAY_MS) },
        },
      }),
    ]);
    const manager = role === 'OWNER' || role === 'ADMIN';
    return {
      waiting: { total, overdue },
      newLeads,
      checklist: manager ? await this.checklist(tenantId, now) : null,
    };
  }

  private async checklist(
    tenantId: string,
    now: Date,
  ): Promise<TodayChecklist> {
    const [channels, groups, prices, knowledge, operators, invites] =
      await Promise.all([
        this.prisma.channelAccount.count({
          where: { tenantId, isTestAccount: false },
        }),
        this.prisma.channelAccount.count({
          where: { tenantId, operatorChatId: { not: null } },
        }),
        this.prisma.sheetCatalog.count({ where: { tenantId } }),
        this.prisma.knowledgeDocument.count({
          where: { tenantId, status: 'ACTIVE' },
        }),
        this.prisma.operator.count({ where: { tenantId, isActive: true } }),
        this.prisma.operatorInvite.count({
          where: {
            tenantId,
            acceptedAt: null,
            revokedAt: null,
            expiresAt: { gt: now },
          },
        }),
      ]);
    return {
      channelConnected: channels > 0,
      hasContent: prices + knowledge > 0,
      teamInvited: operators > 1 || invites > 0,
      operatorGroup: groups > 0,
    };
  }
}
