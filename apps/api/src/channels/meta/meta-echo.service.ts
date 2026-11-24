import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';
import { nextState } from '../../core/handover/state-machine.js';
import { lockConversation } from '../../handover/conversation-lock.js';
import { PrismaService } from '../../persistence/prisma.service.js';
import { runWithTenant } from '../../persistence/tenant-context.js';
import { jsonString } from '../telegram/inbound-batch.js';
import { storedMetaId } from './meta-event-key.js';
import { MetaSentLedger } from './meta-sent-ledger.js';

export const META_ECHO_EVENT = 'meta.echo';
/** Our send records its id when Meta answers; the echo may come first. */
export const META_ECHO_SETTLE_MS = 15_000;

export type EchoOutcome = 'ours' | 'no_conversation' | 'recorded' | 'paused';

/**
 * ADR 088: a person answered the customer from the Instagram or Messenger
 * app. Their message joins the conversation as an operator message and the
 * bot steps back (TAKE_OVER, no operator assigned); the idle return (ADR 038
 * amendment 1) gives it back when the customer is left unanswered.
 */
@Injectable()
export class MetaEchoService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sent: MetaSentLedger,
  ) {}

  async process(
    tenantId: string,
    payload: Prisma.JsonValue,
  ): Promise<EchoOutcome> {
    const channelAccountId = jsonString(payload, 'channelAccountId');
    const customerId = jsonString(payload, 'customerId');
    const mid = jsonString(payload, 'mid');
    const text = jsonString(payload, 'text') ?? '';
    if (!channelAccountId || !customerId || !mid) return 'ours';
    if (await this.sent.has(mid)) return 'ours';
    return runWithTenant(tenantId, () =>
      this.prisma.$transaction(async (tx) => {
        const found = await tx.conversation.findFirst({
          where: { tenantId, channelAccountId, providerChatId: customerId },
          select: { id: true },
        });
        if (!found) return 'no_conversation';
        await lockConversation(tx, tenantId, found.id);
        const providerMessageId = storedMetaId(mid);
        const known = await tx.message.findFirst({
          where: {
            tenantId,
            channelAccountId,
            providerMessageId,
            direction: 'OUTBOUND',
          },
          select: { id: true },
        });
        if (known) return 'ours';
        const conversation = await tx.conversation.findFirstOrThrow({
          where: { tenantId, id: found.id },
          select: { state: true, version: true },
        });
        const latest = await tx.message.findFirst({
          where: { tenantId, conversationId: found.id },
          orderBy: { sequence: 'desc' },
          select: { sequence: true },
        });
        await tx.message.create({
          data: {
            tenantId,
            conversationId: found.id,
            channelAccountId,
            authorType: 'OPERATOR',
            direction: 'OUTBOUND',
            text,
            sequence: (latest?.sequence ?? 0) + 1,
            providerChatId: customerId,
            providerMessageId,
            deliveryState: 'SENT',
          },
        });
        const next = nextState(conversation.state, 'TAKE_OVER');
        if (!next) return 'recorded';
        const moved = await tx.conversation.updateMany({
          where: {
            tenantId,
            id: found.id,
            state: conversation.state,
            version: conversation.version,
          },
          data: {
            state: next,
            assignedOperatorId: null,
            version: { increment: 1 },
          },
        });
        if (moved.count !== 1) return 'recorded';
        const now = new Date();
        const open = await tx.handover.findFirst({
          where: { tenantId, conversationId: found.id, status: 'OPEN' },
          select: { id: true },
        });
        const handoverId = open
          ? (
              await tx.handover.update({
                where: { id: open.id },
                data: {
                  status: 'TAKEN',
                  takenAt: now,
                  version: { increment: 1 },
                },
                select: { id: true },
              })
            ).id
          : (
              await tx.handover.create({
                data: {
                  tenantId,
                  conversationId: found.id,
                  reasonCode: 'OWNER_APP_REPLY',
                  summary: {},
                  status: 'TAKEN',
                  takenAt: now,
                },
                select: { id: true },
              })
            ).id;
        await tx.auditEvent.create({
          data: {
            tenantId,
            actorType: 'SYSTEM',
            actorId: 'meta-app-echo',
            action: 'conversation.app_reply_paused',
            entityType: 'handover',
            entityId: handoverId,
            safeInputSummary: { from: conversation.state, state: next },
          },
        });
        return 'paused';
      }),
    );
  }
}
