import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppEnvironment } from '../config/environment.js';
import { Prisma } from '../generated/prisma/client.js';
import {
  decideFollowUp,
  type FollowUpPolicy,
} from '../core/followup/policy.js';
import { LocaleRegistry } from '../core/locales/locale-pack.js';
import { lockConversation } from '../handover/conversation-lock.js';
import type { ScheduledScan } from '../handover/handover-runtime.js';
import { INITIAL_LOCALE_PACKS } from '../locales/locale-packs.js';
import { PrismaService } from '../persistence/prisma.service.js';

const LOCALES = new LocaleRegistry(INITIAL_LOCALE_PACKS);

/**
 * Follow-up scheduler (Telegram). Off unless FOLLOWUP_ENABLED=true. A scan
 * finds BOT_ACTIVE conversations that have been silent since the bot's last
 * delivered message, asks the pure policy (opt-out, consent, quiet hours,
 * limits, "was there anything of value"), and writes at most one follow-up
 * per ordinal: the unique (conversation, ordinal) row makes a repeated or
 * concurrent scan harmless. The message is a fixed locale template (no
 * commercial facts, no promises, tells how to stop) sent through the normal
 * outbound path, so blocks and failures are handled like any other send.
 */
@Injectable()
export class FollowUpService implements ScheduledScan {
  private readonly logger = new Logger(FollowUpService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<AppEnvironment, true>,
  ) {}

  get enabled(): boolean {
    return this.config.get('FOLLOWUP_ENABLED', { infer: true }) === true;
  }

  policy(): FollowUpPolicy {
    const get = <K extends keyof AppEnvironment>(key: K): AppEnvironment[K] =>
      this.config.get(key, { infer: true });
    return {
      afterHours: get('FOLLOWUP_AFTER_HOURS') ?? 24,
      maxPerConversation: get('FOLLOWUP_MAX_PER_CONVERSATION') ?? 1,
      quietStartHour: get('FOLLOWUP_QUIET_START_HOUR') ?? 21,
      quietEndHour: get('FOLLOWUP_QUIET_END_HOUR') ?? 9,
      maxPerTenantPerDay: get('FOLLOWUP_MAX_PER_TENANT_PER_DAY') ?? 200,
    };
  }

  async scanDue(now: Date): Promise<number> {
    if (!this.enabled) return 0;
    return this.scan(now, this.policy());
  }

  async scan(
    now: Date,
    policy: FollowUpPolicy,
    options: { limit?: number; tenantId?: string } = {},
  ): Promise<number> {
    const limit = options.limit ?? 50;
    const cutoff = new Date(now.getTime() - policy.afterHours * 3_600_000);
    // Candidates are chosen in SQL so that old conversations that can never
    // qualify (customer wrote last, opted out, nothing of value, limit
    // reached) cannot crowd the eligible ones out of the first `limit`.
    const candidates = await this.prisma.$queryRaw<
      Array<{ id: string; tenantId: string }>
    >(Prisma.sql`
      SELECT c.id AS id, c.tenant_id AS "tenantId"
      FROM conversations c
      JOIN tenants t ON t.id = c.tenant_id AND t.status = 'ACTIVE'
      JOIN channel_accounts a ON a.tenant_id = c.tenant_id AND a.id = c.channel_account_id
        AND a.channel_type = 'telegram' AND a.status = 'ACTIVE'
      JOIN contacts k ON k.tenant_id = c.tenant_id AND k.id = c.contact_id
        AND k.marketing_opt_out = false AND k.consent_status <> 'REVOKED' AND k.deleted_at IS NULL
      JOIN LATERAL (
        SELECT m.direction, m.author_type, m.delivery_state, m.created_at
        FROM messages m
        WHERE m.tenant_id = c.tenant_id AND m.conversation_id = c.id
        ORDER BY m.sequence DESC LIMIT 1
      ) lm ON true
      WHERE c.state = 'BOT_ACTIVE'
        ${options.tenantId ? Prisma.sql`AND c.tenant_id = ${options.tenantId}::uuid` : Prisma.empty}
        AND lm.direction = 'OUTBOUND' AND lm.author_type = 'BOT'
        AND lm.delivery_state = 'SENT' AND lm.created_at < ${cutoff}
        AND (SELECT count(*) FROM follow_ups f
             WHERE f.tenant_id = c.tenant_id AND f.conversation_id = c.id) < ${policy.maxPerConversation}
        AND (EXISTS (SELECT 1 FROM shown_offers s
                     WHERE s.tenant_id = c.tenant_id AND s.conversation_id = c.id)
             OR EXISTS (SELECT 1 FROM leads l
                        WHERE l.tenant_id = c.tenant_id AND l.conversation_id = c.id
                          AND l.score IN ('HOT', 'WARM')))
      ORDER BY lm.created_at ASC
      LIMIT ${limit}
    `);
    let sent = 0;
    const sentToday = new Map<string, number>();
    for (const candidate of candidates) {
      // Blast guard: a tenant never exceeds its rolling 24-hour allowance.
      let today = sentToday.get(candidate.tenantId);
      if (today === undefined) {
        today = await this.prisma.followUp.count({
          where: {
            tenantId: candidate.tenantId,
            createdAt: { gte: new Date(now.getTime() - 86_400_000) },
          },
        });
      }
      if (today >= policy.maxPerTenantPerDay) {
        sentToday.set(candidate.tenantId, today);
        continue;
      }
      try {
        if (
          await this.consider(candidate.tenantId, candidate.id, now, policy)
        ) {
          sent += 1;
          today += 1;
        }
        sentToday.set(candidate.tenantId, today);
      } catch (error) {
        this.logger.warn(
          JSON.stringify({
            event: 'followup.failed',
            tenant: candidate.tenantId,
            name: (error as Error).name,
          }),
        );
      }
    }
    return sent;
  }

  private async consider(
    tenantId: string,
    conversationId: string,
    now: Date,
    policy: FollowUpPolicy,
  ): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      await lockConversation(tx, tenantId, conversationId);
      const conversation = await tx.conversation.findFirst({
        where: { tenantId, id: conversationId },
        include: {
          contact: true,
          channelAccount: { select: { id: true } },
          tenant: { select: { timezone: true, defaultLocale: true } },
          messages: { orderBy: { sequence: 'desc' }, take: 1 },
        },
      });
      const last = conversation?.messages[0];
      if (!conversation || !last) return false;
      const [count, shown, lead] = await Promise.all([
        tx.followUp.count({ where: { tenantId, conversationId } }),
        tx.shownOffer.count({ where: { tenantId, conversationId } }),
        tx.lead.findFirst({
          where: { tenantId, conversationId, score: { in: ['HOT', 'WARM'] } },
          select: { id: true },
        }),
      ]);
      const decision = decideFollowUp(
        {
          state: conversation.state,
          lastMessage: {
            direction: last.direction,
            author: last.authorType,
            delivered: last.deliveryState === 'SENT',
            at: last.createdAt,
          },
          contact: {
            marketingOptOut: conversation.contact.marketingOptOut,
            consent: conversation.contact.consentStatus,
            deleted: conversation.contact.deletedAt !== null,
          },
          followUpsSent: count,
          hasValue: shown > 0 || lead !== null,
          timeZone: conversation.tenant.timezone,
        },
        now,
        policy,
      );
      if (!decision.send) return false;
      const pack =
        LOCALES.all().find(
          (p) =>
            p.language === conversation.language &&
            p.script === conversation.script,
        ) ??
        LOCALES.all().find((p) => p.id === conversation.tenant.defaultLocale) ??
        LOCALES.all()[0];
      try {
        const message = await tx.message.create({
          data: {
            tenantId,
            conversationId,
            channelAccountId: conversation.channelAccountId,
            authorType: 'BOT',
            direction: 'OUTBOUND',
            type: 'TEXT',
            text: pack.templates.followUp,
            sequence: last.sequence + 1,
            providerChatId: conversation.providerChatId,
            deliveryState: 'PENDING',
            sendIdempotencyKey: `follow-up:${conversationId}:${count + 1}`,
          },
          select: { id: true },
        });
        await tx.followUp.create({
          data: {
            tenantId,
            conversationId,
            ordinal: count + 1,
            messageId: message.id,
            createdAt: now, // the scan's clock: the daily allowance counts on it
          },
        });
        await tx.outboxEvent.create({
          data: {
            tenantId,
            type: 'telegram.send',
            aggregateType: 'message',
            aggregateId: message.id,
            idempotencyKey: `telegram.send:${message.id}`,
            payload: { messageId: message.id } satisfies Prisma.InputJsonObject,
          },
        });
        return true;
      } catch (error) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2002'
        )
          return false; // another scan already created this ordinal
        throw error;
      }
    });
  }
}
