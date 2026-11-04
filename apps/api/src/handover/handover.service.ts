import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../persistence/prisma.service.js';
import {
  nextState,
  operatorMaySpeak,
  type ConversationState,
} from '../core/handover/state-machine.js';
import {
  lockConversation,
  type TransactionClient,
} from './conversation-lock.js';
import { latestLead, setOperatorLeadScore } from '../leads/lead-operator.js';

export type CommandRejection =
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'ILLEGAL_STATE'
  | 'ALREADY_TAKEN'
  | 'NOT_ASSIGNED'
  | 'EMPTY_TEXT'
  | 'NO_LEAD'
  | 'NOT_RESENDABLE';

export type CommandResult =
  | {
      readonly status: 'OK';
      readonly handoverId: string;
      readonly state: ConversationState;
      readonly messageId?: string;
    }
  | { readonly status: 'DUPLICATE'; readonly handoverId: string }
  | { readonly status: 'REJECTED'; readonly code: CommandRejection };

interface CommandBase {
  readonly tenantId: string;
  readonly handoverId: string;
  readonly operatorId: string;
  /** Idempotency key supplied by the caller (header, callback id, ...). */
  readonly idempotencyKey: string;
}

const OPERATING_ROLES = ['OWNER', 'ADMIN', 'OPERATOR'] as const;
const MAX_REPLY = 4_096;
const MAX_NOTE = 2_000;

interface Context {
  readonly tx: TransactionClient;
  readonly handover: {
    id: string;
    conversationId: string;
    status: 'OPEN' | 'TAKEN' | 'RESOLVED' | 'CANCELLED';
  };
  readonly conversation: {
    id: string;
    state: ConversationState;
    version: number;
    assignedOperatorId: string | null;
    channelAccountId: string;
    providerChatId: string;
  };
  readonly operator: {
    id: string;
    role: 'OWNER' | 'ADMIN' | 'OPERATOR' | 'VIEWER';
  };
}

/**
 * Operator commands and handover creation (spec §12A.2, Phase 5). Every
 * command runs in one short transaction under the conversation advisory lock,
 * is tenant-scoped, authorizes an active operator of that tenant, is
 * idempotent on (action, idempotency key) through a unique audit row, and
 * changes ownership with a version compare-and-set. Telegram, queues and
 * models are not involved here.
 */
@Injectable()
export class HandoverService {
  constructor(private readonly prisma: PrismaService) {}

  /** Active operator of the tenant behind a Telegram user id, if any. */
  async operatorByTelegram(
    tenantId: string,
    telegramUserId: string,
  ): Promise<{ id: string; role: string } | undefined> {
    const operator = await this.prisma.operator.findFirst({
      where: {
        tenantId,
        telegramUserId,
        isActive: true,
        role: { in: [...OPERATING_ROLES] },
      },
      select: { id: true, role: true },
    });
    return operator ?? undefined;
  }

  /**
   * Called inside the agent commit transaction: records the handover, moves
   * the conversation to WAITING_OPERATOR (version compare-and-set) and queues
   * the operator notification. Returns undefined when the conversation moved
   * on (nothing is created then).
   */
  async openHandover(
    tx: TransactionClient,
    input: {
      tenantId: string;
      conversationId: string;
      reason: string;
      summary: Prisma.InputJsonValue;
      idempotencyKey: string;
      conversationVersion: number;
      slaMinutes: number;
      now?: Date;
    },
  ): Promise<string | undefined> {
    const now = input.now ?? new Date();
    const moved = await tx.conversation.updateMany({
      where: {
        tenantId: input.tenantId,
        id: input.conversationId,
        state: 'BOT_ACTIVE',
        version: input.conversationVersion,
      },
      data: { state: 'WAITING_OPERATOR', version: { increment: 1 } },
    });
    if (moved.count !== 1) return undefined;
    const handover = await tx.handover.create({
      data: {
        tenantId: input.tenantId,
        conversationId: input.conversationId,
        reasonCode: input.reason,
        idempotencyKey: input.idempotencyKey,
        summary: input.summary,
        slaDueAt: new Date(now.getTime() + input.slaMinutes * 60_000),
      },
      select: { id: true },
    });
    await tx.outboxEvent.create({
      data: {
        tenantId: input.tenantId,
        type: 'handover.notify',
        aggregateType: 'handover',
        aggregateId: handover.id,
        idempotencyKey: `handover.notify:${handover.id}`,
        payload: { handoverId: handover.id } satisfies Prisma.InputJsonObject,
      },
    });
    return handover.id;
  }

  /** A customer writing to a closed conversation reopens it for the bot. */
  async reopenIfClosed(
    tx: TransactionClient,
    tenantId: string,
    conversationId: string,
  ): Promise<boolean> {
    const next = nextState('CLOSED', 'REOPEN');
    if (!next) return false;
    const reopened = await tx.conversation.updateMany({
      where: { tenantId, id: conversationId, state: 'CLOSED' },
      data: {
        state: next,
        assignedOperatorId: null,
        version: { increment: 1 },
      },
    });
    return reopened.count === 1;
  }

  private async command(
    action: string,
    base: CommandBase,
    body: (
      context: Context,
    ) => Promise<
      | CommandResult
      | Omit<Extract<CommandResult, { status: 'OK' }>, 'handoverId'>
    >,
    summary: Prisma.InputJsonObject = {},
  ): Promise<CommandResult> {
    try {
      return await this.prisma.$transaction(
        async (tx): Promise<CommandResult> => {
          const handover = await tx.handover.findFirst({
            where: { id: base.handoverId, tenantId: base.tenantId },
            select: { id: true, conversationId: true, status: true },
          });
          if (!handover) return { status: 'REJECTED', code: 'NOT_FOUND' };
          await lockConversation(tx, base.tenantId, handover.conversationId);
          const done = await tx.auditEvent.findFirst({
            where: {
              tenantId: base.tenantId,
              action,
              idempotencyKey: base.idempotencyKey,
            },
            select: { id: true },
          });
          if (done) return { status: 'DUPLICATE', handoverId: handover.id };
          const operator = await tx.operator.findFirst({
            where: {
              id: base.operatorId,
              tenantId: base.tenantId,
              isActive: true,
              role: { in: [...OPERATING_ROLES] },
            },
            select: { id: true, role: true },
          });
          if (!operator) return { status: 'REJECTED', code: 'FORBIDDEN' };
          const conversation = await tx.conversation.findFirst({
            where: { tenantId: base.tenantId, id: handover.conversationId },
            select: {
              id: true,
              state: true,
              version: true,
              assignedOperatorId: true,
              channelAccountId: true,
              providerChatId: true,
            },
          });
          if (!conversation) return { status: 'REJECTED', code: 'NOT_FOUND' };
          const outcome = await body({
            tx,
            handover,
            conversation,
            operator,
          });
          if (outcome.status === 'REJECTED' || outcome.status === 'DUPLICATE')
            return outcome;
          const ok: CommandResult = {
            ...outcome,
            status: 'OK',
            handoverId: handover.id,
          };
          await tx.auditEvent.create({
            data: {
              tenantId: base.tenantId,
              actorType: 'OPERATOR',
              actorId: operator.id,
              action,
              entityType: 'handover',
              entityId: handover.id,
              safeInputSummary: { ...summary, state: ok.state },
              idempotencyKey: base.idempotencyKey,
            },
          });
          return ok;
        },
      );
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        return { status: 'DUPLICATE', handoverId: base.handoverId };
      }
      throw error;
    }
  }

  /** Atomic take-over: exactly one of any number of competing operators wins. */
  takeOver(command: CommandBase): Promise<CommandResult> {
    return this.command('operator.take_over', command, async (c) => {
      const mine =
        c.conversation.state === 'OPERATOR_ACTIVE' &&
        c.conversation.assignedOperatorId === c.operator.id;
      if (mine) return { status: 'OK', state: 'OPERATOR_ACTIVE' } as const;
      if (c.conversation.state === 'OPERATOR_ACTIVE')
        return { status: 'REJECTED', code: 'ALREADY_TAKEN' } as const;
      const next = nextState(c.conversation.state, 'TAKE_OVER');
      if (!next || c.handover.status !== 'OPEN')
        return { status: 'REJECTED', code: 'ILLEGAL_STATE' } as const;
      const claimed = await c.tx.conversation.updateMany({
        where: {
          tenantId: command.tenantId,
          id: c.conversation.id,
          state: c.conversation.state,
          version: c.conversation.version,
        },
        data: {
          state: next,
          assignedOperatorId: c.operator.id,
          version: { increment: 1 },
        },
      });
      if (claimed.count !== 1)
        return { status: 'REJECTED', code: 'ALREADY_TAKEN' } as const;
      await c.tx.handover.updateMany({
        where: {
          tenantId: command.tenantId,
          id: c.handover.id,
          status: 'OPEN',
        },
        data: {
          status: 'TAKEN',
          assignedOperatorId: c.operator.id,
          takenAt: new Date(),
          version: { increment: 1 },
        },
      });
      return { status: 'OK', state: next } as const;
    });
  }

  /**
   * Operator-initiated take-over from the conversation (ADR 038): the bot
   * stops answering from this commit (its pending reply is dropped by the
   * BOT_ACTIVE check before sending). An open hand-over is taken; without one,
   * a hand-over is created already TAKEN with reason OPERATOR_INITIATED, so
   * replies and "return to bot" keep their hand-over-based path. No operator
   * group card and no SLA: an operator is already on it.
   */
  async takeOverConversation(command: {
    readonly tenantId: string;
    readonly conversationId: string;
    readonly operatorId: string;
    readonly idempotencyKey: string;
  }): Promise<CommandResult> {
    const action = 'operator.take_over';
    return this.prisma.$transaction(async (tx): Promise<CommandResult> => {
      const exists = await tx.conversation.findFirst({
        where: { tenantId: command.tenantId, id: command.conversationId },
        select: { id: true },
      });
      if (!exists) return { status: 'REJECTED', code: 'NOT_FOUND' };
      await lockConversation(tx, command.tenantId, exists.id);
      const open = (): Promise<{ id: string; status: string } | null> =>
        tx.handover.findFirst({
          where: {
            tenantId: command.tenantId,
            conversationId: exists.id,
            status: { in: ['OPEN', 'TAKEN'] },
          },
          orderBy: { openedAt: 'desc' },
          select: { id: true, status: true },
        });
      const done = await tx.auditEvent.findFirst({
        where: {
          tenantId: command.tenantId,
          action,
          idempotencyKey: command.idempotencyKey,
        },
        select: { entityId: true },
      });
      if (done) return { status: 'DUPLICATE', handoverId: done.entityId };
      const operator = await tx.operator.findFirst({
        where: {
          id: command.operatorId,
          tenantId: command.tenantId,
          isActive: true,
          role: { in: [...OPERATING_ROLES] },
        },
        select: { id: true },
      });
      if (!operator) return { status: 'REJECTED', code: 'FORBIDDEN' };
      const conversation = await tx.conversation.findFirstOrThrow({
        where: { tenantId: command.tenantId, id: exists.id },
        select: { state: true, version: true, assignedOperatorId: true },
      });
      const current = await open();
      if (conversation.state === 'OPERATOR_ACTIVE') {
        if (conversation.assignedOperatorId === operator.id && current)
          return {
            status: 'OK',
            handoverId: current.id,
            state: 'OPERATOR_ACTIVE',
          };
        return { status: 'REJECTED', code: 'ALREADY_TAKEN' };
      }
      const next = nextState(conversation.state, 'TAKE_OVER');
      if (!next) return { status: 'REJECTED', code: 'ILLEGAL_STATE' };
      const claimed = await tx.conversation.updateMany({
        where: {
          tenantId: command.tenantId,
          id: exists.id,
          state: conversation.state,
          version: conversation.version,
        },
        data: {
          state: next,
          assignedOperatorId: operator.id,
          version: { increment: 1 },
        },
      });
      if (claimed.count !== 1)
        return { status: 'REJECTED', code: 'ALREADY_TAKEN' };
      const now = new Date();
      const handoverId = current
        ? (
            await tx.handover.update({
              where: { id: current.id },
              data: {
                status: 'TAKEN',
                assignedOperatorId: operator.id,
                takenAt: now,
                version: { increment: 1 },
              },
              select: { id: true },
            })
          ).id
        : (
            await tx.handover.create({
              data: {
                tenantId: command.tenantId,
                conversationId: exists.id,
                reasonCode: 'OPERATOR_INITIATED',
                summary: {},
                status: 'TAKEN',
                assignedOperatorId: operator.id,
                takenAt: now,
              },
              select: { id: true },
            })
          ).id;
      await tx.auditEvent.create({
        data: {
          tenantId: command.tenantId,
          actorType: 'OPERATOR',
          actorId: operator.id,
          action,
          entityType: 'handover',
          entityId: handoverId,
          safeInputSummary: {
            state: next,
            from: conversation.state,
            via: 'conversation',
          },
          idempotencyKey: command.idempotencyKey,
        },
      });
      return { status: 'OK', handoverId, state: next };
    });
  }

  /** Delivers an operator message through the normal outbound path. */
  reply(command: CommandBase & { text: string }): Promise<CommandResult> {
    const text = command.text.trim();
    return this.command(
      'operator.reply',
      command,
      async (c) => {
        if (text.length === 0)
          return { status: 'REJECTED', code: 'EMPTY_TEXT' } as const;
        if (!operatorMaySpeak(c.conversation.state))
          return { status: 'REJECTED', code: 'ILLEGAL_STATE' } as const;
        if (c.conversation.assignedOperatorId !== c.operator.id)
          return { status: 'REJECTED', code: 'NOT_ASSIGNED' } as const;
        const latest = await c.tx.message.findFirst({
          where: {
            tenantId: command.tenantId,
            conversationId: c.conversation.id,
          },
          orderBy: { sequence: 'desc' },
          select: { sequence: true },
        });
        const message = await c.tx.message.create({
          data: {
            tenantId: command.tenantId,
            conversationId: c.conversation.id,
            channelAccountId: c.conversation.channelAccountId,
            authorType: 'OPERATOR',
            direction: 'OUTBOUND',
            type: 'TEXT',
            text: text.slice(0, MAX_REPLY),
            sequence: (latest?.sequence ?? 0) + 1,
            providerChatId: c.conversation.providerChatId,
            deliveryState: 'PENDING',
            sendIdempotencyKey: `operator-reply:${command.idempotencyKey}`,
          },
          select: { id: true },
        });
        await c.tx.outboxEvent.create({
          data: {
            tenantId: command.tenantId,
            type: 'telegram.send',
            aggregateType: 'message',
            aggregateId: message.id,
            idempotencyKey: `telegram.send:${message.id}`,
            payload: { messageId: message.id } satisfies Prisma.InputJsonObject,
          },
        });
        return {
          status: 'OK',
          state: c.conversation.state,
          messageId: message.id,
        } as const;
      },
      { length: Math.min(text.length, MAX_REPLY) },
    );
  }

  /** Gives the conversation back to the bot (assigned operator or admin). */
  returnToBot(command: CommandBase): Promise<CommandResult> {
    return this.release('operator.return_to_bot', 'RETURN_TO_BOT', command);
  }

  close(command: CommandBase): Promise<CommandResult> {
    return this.release('operator.close', 'CLOSE', command);
  }

  private release(
    action: string,
    transition: 'RETURN_TO_BOT' | 'CLOSE',
    command: CommandBase,
  ): Promise<CommandResult> {
    return this.command(action, command, async (c) => {
      const next = nextState(c.conversation.state, transition);
      if (!next) return { status: 'REJECTED', code: 'ILLEGAL_STATE' } as const;
      const privileged =
        c.operator.role === 'ADMIN' || c.operator.role === 'OWNER';
      if (
        c.conversation.state === 'OPERATOR_ACTIVE' &&
        c.conversation.assignedOperatorId !== c.operator.id &&
        !privileged
      )
        return { status: 'REJECTED', code: 'NOT_ASSIGNED' } as const;
      const moved = await c.tx.conversation.updateMany({
        where: {
          tenantId: command.tenantId,
          id: c.conversation.id,
          state: c.conversation.state,
          version: c.conversation.version,
        },
        data: {
          state: next,
          assignedOperatorId: null,
          version: { increment: 1 },
        },
      });
      if (moved.count !== 1)
        return { status: 'REJECTED', code: 'ILLEGAL_STATE' } as const;
      await c.tx.handover.updateMany({
        where: {
          tenantId: command.tenantId,
          conversationId: c.conversation.id,
          status: { in: ['OPEN', 'TAKEN'] },
        },
        data: {
          status: 'RESOLVED',
          resolvedAt: new Date(),
          version: { increment: 1 },
        },
      });
      return { status: 'OK', state: next } as const;
    });
  }

  /** Internal note; never sent to the customer. Any state, any operator. */
  addNote(command: CommandBase & { text: string }): Promise<CommandResult> {
    const text = command.text.trim().slice(0, MAX_NOTE);
    return this.command(
      'operator.add_note',
      command,
      async (c) => {
        if (text.length === 0)
          return { status: 'REJECTED', code: 'EMPTY_TEXT' } as const;
        await c.tx.internalNote.create({
          data: {
            tenantId: command.tenantId,
            conversationId: c.conversation.id,
            operatorId: c.operator.id,
            text,
            idempotencyKey: `note:${command.idempotencyKey}`,
          },
        });
        return { status: 'OK', state: c.conversation.state } as const;
      },
      { length: text.length },
    );
  }

  /** Changes the status of the conversation's latest lead (audited, idempotent). */
  setLeadStatus(
    command: CommandBase & { status: 'NEW' | 'IN_PROGRESS' | 'WON' | 'LOST' },
  ): Promise<CommandResult> {
    return this.command(
      'operator.set_lead_status',
      command,
      async (c) => {
        const lead = await c.tx.lead.findFirst({
          where: {
            tenantId: command.tenantId,
            conversationId: c.conversation.id,
          },
          orderBy: { createdAt: 'desc' },
          select: { id: true },
        });
        if (!lead) return { status: 'REJECTED', code: 'NO_LEAD' } as const;
        await c.tx.lead.updateMany({
          where: { tenantId: command.tenantId, id: lead.id },
          data: { status: command.status },
        });
        return { status: 'OK', state: c.conversation.state } as const;
      },
      { leadStatus: command.status },
    );
  }

  /**
   * An operator sets the lead's score (ADR 037); `null` returns it to
   * automatic scoring, which applies from the next customer turn. The CRM
   * copy is refreshed when the CRM can still take it.
   */
  setLeadScore(
    command: CommandBase & { score: 'HOT' | 'WARM' | 'COLD' | null },
  ): Promise<CommandResult> {
    return this.command(
      'operator.set_lead_score',
      command,
      async (c) => {
        const lead = await latestLead(
          c.tx,
          command.tenantId,
          c.conversation.id,
        );
        if (!lead) return { status: 'REJECTED', code: 'NO_LEAD' } as const;
        await setOperatorLeadScore(c.tx, command.tenantId, lead, command.score);
        return { status: 'OK', state: c.conversation.state } as const;
      },
      { leadScore: command.score ?? 'AUTO' },
    );
  }

  /**
   * Sends a lead that was kept local (no CRM at the time) to the CRM now
   * (ADR 037). Only a NOT_REQUIRED lead: failed and uncertain writes have
   * their own retry and resolution paths.
   */
  resendLeadToCrm(command: CommandBase): Promise<CommandResult> {
    return this.command('operator.resend_lead_to_crm', command, async (c) => {
      const lead = await c.tx.lead.findFirst({
        where: {
          tenantId: command.tenantId,
          conversationId: c.conversation.id,
        },
        orderBy: { createdAt: 'desc' },
        select: { id: true, crmSyncStatus: true },
      });
      if (!lead) return { status: 'REJECTED', code: 'NO_LEAD' } as const;
      if (lead.crmSyncStatus !== 'NOT_REQUIRED')
        return { status: 'REJECTED', code: 'NOT_RESENDABLE' } as const;
      await c.tx.lead.updateMany({
        where: {
          tenantId: command.tenantId,
          id: lead.id,
          crmSyncStatus: 'NOT_REQUIRED',
        },
        data: { crmSyncStatus: 'PENDING', lastErrorCode: null },
      });
      await this.queueLeadSync(
        c.tx,
        command.tenantId,
        lead.id,
        `resend:${Date.now()}`,
      );
      return { status: 'OK', state: c.conversation.state } as const;
    });
  }

  private async queueLeadSync(
    tx: TransactionClient,
    tenantId: string,
    leadId: string,
    suffix: string,
  ): Promise<void> {
    await tx.outboxEvent.createMany({
      data: [
        {
          tenantId,
          type: 'crm.lead.sync',
          aggregateType: 'lead',
          aggregateId: leadId,
          idempotencyKey: `crm.lead.sync:${leadId}:${suffix}`,
          payload: { leadId } satisfies Prisma.InputJsonObject,
        },
      ],
      skipDuplicates: true,
    });
  }
}
