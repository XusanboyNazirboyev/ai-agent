import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { HandoverSummary } from '@agentcore/shared';
import { randomUUID } from 'node:crypto';
import {
  AgentConfigurationError,
  AgentConversationService,
  type ComputedTurn,
} from '../../agent/agent-conversation.service.js';
import {
  AGENT_MODE_POLICY,
  agentModePolicy,
  effectiveAgentMode,
  type AgentModePolicy,
  type AgentModeValue,
} from '../../agent/agent-mode.js';
import type { AppEnvironment } from '../../config/environment.js';
import { redactPii } from '../../core/agent/redaction.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../persistence/prisma.service.js';
import { HandoverService } from '../../handover/handover.service.js';
import { LeadService } from '../../leads/lead.service.js';
import { extractPhone } from '../../leads/phone.js';
import { selectInboundBatch } from './inbound-batch.js';
import type {
  ProcessResult,
  TelegramQueueEvent,
} from './telegram-processor.js';

type TransactionClient = Prisma.TransactionClient;

/** How long a job waits before re-checking a conversation another turn holds. */
const BUSY_RETRY_MS = 2_000;
/** Re-runs after a newer customer message superseded the computed reply. */
const MAX_ROUNDS = 3;

interface Claim {
  readonly turnId: string;
  readonly correlationId: string;
  readonly mode: AgentModeValue;
  readonly conversationVersion: number;
  readonly channelAccountId: string;
  readonly providerChatId: string;
  readonly eventIds: readonly string[];
  readonly firstSequence: number;
  readonly answeredSequence: number;
  readonly idempotencyKey: string;
  readonly text: string;
}

type ClaimResult =
  | { readonly kind: 'claimed'; readonly claim: Claim }
  | { readonly kind: 'busy'; readonly retryAt: Date }
  | { readonly kind: 'none'; readonly reason: string };

export type CommitResult =
  'COMMITTED' | 'SUPERSEDED' | 'STATE_CHANGED' | 'LOST' | 'FAILED';

function lockKey(tenantId: string, conversationId: string): string {
  // Same key as the webhook and the echo path: one writer per conversation.
  return `agentcore:${tenantId}:${conversationId}`;
}

async function lockConversation(
  tx: TransactionClient,
  tenantId: string,
  conversationId: string,
): Promise<void> {
  await tx.$queryRaw`SELECT 1::int AS locked FROM (SELECT pg_advisory_xact_lock(hashtextextended(${lockKey(tenantId, conversationId)}, 0))) AS lock_result`;
}

/**
 * Agent turn pipeline for Telegram (ADR 009). Three steps, so no database
 * transaction, row lock or pooled connection is held while the model runs:
 *
 *  1. CLAIM (short transaction under the conversation advisory lock):
 *     conversation must be BOT_ACTIVE; at most one COMPUTING turn per
 *     conversation (partial unique index); the debounced batch is marked
 *     PROCESSING and a COMPUTING AgentTurn records the answered sequence,
 *     the highest visible inbound sequence and the conversation version.
 *  2. COMPUTE (no transaction): the agent turn. Its only writes are LLM
 *     usage records, keyed by this attempt, so cost is recorded once per
 *     attempt even if the worker dies.
 *  3. COMMIT (short transaction under the same lock): the turn must still be
 *     this worker's COMPUTING attempt; if the conversation left BOT_ACTIVE or
 *     changed version (operator takeover) the reply is discarded and the
 *     batch closed; if a newer inbound message arrived, the reply is
 *     discarded, the batch released, and the turn re-run with the merged
 *     batch (at most MAX_ROUNDS). Otherwise slots, the turn record and, in
 *     LIVE mode, the outbound message, its outbox event and any durable
 *     Handover are written atomically.
 *
 * Idempotency: one COMMITTED turn per `agent-reply:<conversation>:<answered
 * sequence>` (partial unique index); the outbound message carries the same
 * key. A crash between compute and commit leaves a COMPUTING turn that the
 * same job abandons on retry (or any job once its lease expires).
 */
@Injectable()
export class TelegramAgentPipeline {
  private readonly logger = new Logger(TelegramAgentPipeline.name);
  private readonly policy: AgentModePolicy;
  private readonly handoverService: HandoverService;
  private readonly leadService: LeadService;

  constructor(
    private readonly prisma: PrismaService,
    private readonly agent: AgentConversationService,
    private readonly config: ConfigService<AppEnvironment, true>,
    @Optional() @Inject(AGENT_MODE_POLICY) policy?: AgentModePolicy,
    @Optional() handovers?: HandoverService,
    @Optional() leads?: LeadService,
  ) {
    this.handoverService = handovers ?? new HandoverService(prisma);
    this.leadService = leads ?? new LeadService(prisma);
    this.policy =
      policy ??
      agentModePolicy({
        NODE_ENV: this.config.get('NODE_ENV', { infer: true }),
        LLM_PROVIDER: this.config.get('LLM_PROVIDER', { infer: true }),
        LLM_TRUSTED_PROVIDERS: this.config.get('LLM_TRUSTED_PROVIDERS', {
          infer: true,
        }),
        LLM_ALLOW_REAL_CUSTOMER_DATA: this.config.get(
          'LLM_ALLOW_REAL_CUSTOMER_DATA',
          { infer: true },
        ),
      });
  }

  /** The channel account's configured agent mode for a conversation. */
  async modeFor(
    tenantId: string,
    conversationId: string,
  ): Promise<AgentModeValue> {
    return (await this.accountFor(tenantId, conversationId)).agentMode;
  }

  private async accountFor(
    tenantId: string,
    conversationId: string,
  ): Promise<{ agentMode: AgentModeValue; isTestAccount: boolean }> {
    const row = await this.prisma.conversation.findFirst({
      where: { tenantId, id: conversationId },
      select: {
        channelAccount: { select: { agentMode: true, isTestAccount: true } },
      },
    });
    return row?.channelAccount ?? { agentMode: 'OFF', isTestAccount: false };
  }

  async run(
    event: TelegramQueueEvent,
    input: {
      readonly inboundEventId: string;
      readonly conversationId: string;
      readonly requestedMode: AgentModeValue;
    },
  ): Promise<ProcessResult> {
    const account = await this.accountFor(event.tenantId, input.conversationId);
    const effective = effectiveAgentMode(
      input.requestedMode,
      this.policy,
      account,
    );
    if (effective.refusal) {
      this.logger.error(
        JSON.stringify({
          event: 'agent.mode_refused',
          tenant: event.tenantId,
          conversation: input.conversationId,
          requestedMode: input.requestedMode,
          appliedMode: effective.mode,
        }),
      );
    }
    if (effective.mode === 'HOLD') {
      await this.hold(event, input.inboundEventId, input.conversationId);
      return;
    }
    if (effective.mode === 'OFF') return;
    for (let round = 1; round <= MAX_ROUNDS; round++) {
      const claimed = await this.claim(
        event,
        input.inboundEventId,
        input.conversationId,
        effective.mode,
      );
      if (claimed.kind === 'busy') return { retryAt: claimed.retryAt };
      if (claimed.kind === 'none') return;
      const { claim } = claimed;

      let computed: ComputedTurn;
      try {
        computed = await this.agent.compute({
          tenantId: event.tenantId,
          conversationId: input.conversationId,
          turnKey: claim.turnId,
          text: claim.text,
          beforeSequence: claim.firstSequence,
        });
      } catch (error: unknown) {
        await this.fail(event.tenantId, input.conversationId, claim, error);
        if (error instanceof AgentConfigurationError) return;
        throw error;
      }

      const result = await this.commit(
        event.tenantId,
        input.conversationId,
        claim,
        computed,
      );
      this.logger.log(
        JSON.stringify({
          event: 'agent.turn_committed',
          tenant: event.tenantId,
          conversation: input.conversationId,
          turn: claim.turnId,
          correlationId: claim.correlationId,
          mode: claim.mode,
          result,
          outcome: computed.result.outcome,
          handover: computed.result.handover,
          round,
        }),
      );
      if (result !== 'SUPERSEDED') return;
    }
    // Still superseded: the batch is RECEIVED again and the newest message's
    // own job answers it once the customer pauses.
  }

  /**
   * HOLD: the configured mode may not run (e.g. an untrusted provider on a
   * real account). Close the batch without calling the model or replying.
   */
  private async hold(
    event: TelegramQueueEvent,
    inboundEventId: string,
    conversationId: string,
  ): Promise<void> {
    const { tenantId } = event;
    await this.prisma.$transaction(async (tx) => {
      await lockConversation(tx, tenantId, conversationId);
      const initial = await tx.inboundEvent.findFirst({
        where: { id: inboundEventId, tenantId, status: 'RECEIVED' },
        select: { channelAccountId: true },
      });
      if (!initial) return;
      const batch = await selectInboundBatch(
        tx,
        tenantId,
        initial.channelAccountId,
        conversationId,
      );
      if (!batch) return;
      await tx.inboundEvent.updateMany({
        where: {
          tenantId,
          id: { in: [...batch.eventIds] },
          status: 'RECEIVED',
        },
        data: { status: 'PROCESSED', processedAt: new Date() },
      });
    });
  }

  /** Marks turns owned by an exhausted job FAILED and fails their batch. */
  async failOwnedTurns(event: TelegramQueueEvent): Promise<void> {
    const owned = await this.prisma.agentTurn.findMany({
      where: {
        tenantId: event.tenantId,
        claimToken: event.outboxId,
        status: 'COMPUTING',
      },
      select: { id: true, inboundEventIds: true },
    });
    for (const turn of owned) {
      await this.prisma.$transaction([
        this.prisma.agentTurn.updateMany({
          where: { id: turn.id, tenantId: event.tenantId, status: 'COMPUTING' },
          data: {
            status: 'FAILED',
            failureCode: 'RETRIES_EXHAUSTED',
            completedAt: new Date(),
          },
        }),
        this.prisma.inboundEvent.updateMany({
          where: {
            tenantId: event.tenantId,
            id: { in: turn.inboundEventIds },
            status: 'PROCESSING',
          },
          data: { status: 'FAILED' },
        }),
      ]);
    }
  }

  private async claim(
    event: TelegramQueueEvent,
    inboundEventId: string,
    conversationId: string,
    mode: 'SHADOW' | 'LIVE',
  ): Promise<ClaimResult> {
    const { tenantId } = event;
    const leaseMs = this.config.get('AGENT_TURN_LEASE_MS', { infer: true });
    return this.prisma.$transaction(async (tx): Promise<ClaimResult> => {
      await lockConversation(tx, tenantId, conversationId);
      const initial = await tx.inboundEvent.findFirst({
        where: { id: inboundEventId, tenantId },
        select: { channelAccountId: true, status: true },
      });
      if (
        !initial ||
        initial.status === 'PROCESSED' ||
        initial.status === 'FAILED'
      ) {
        return { kind: 'none', reason: 'NOTHING_PENDING' };
      }

      const now = new Date();
      const open = await tx.agentTurn.findFirst({
        where: { tenantId, conversationId, status: 'COMPUTING' },
      });
      if (open) {
        const mine = open.claimToken === event.outboxId;
        if (!mine && open.leaseExpiresAt > now) {
          // Another worker is computing; its commit picks up new messages.
          return {
            kind: 'busy',
            retryAt: new Date(now.getTime() + BUSY_RETRY_MS),
          };
        }
        // This job's own earlier attempt (it crashed or was retried), or a
        // dead worker's expired lease: abandon it and release its batch.
        await tx.agentTurn.update({
          where: { id: open.id },
          data: {
            status: 'ABANDONED',
            discardReason: mine ? 'RETRIED' : 'LEASE_EXPIRED',
            completedAt: now,
          },
        });
        await tx.inboundEvent.updateMany({
          where: {
            tenantId,
            id: { in: open.inboundEventIds },
            status: 'PROCESSING',
          },
          data: { status: 'RECEIVED' },
        });
        this.logger.warn(
          JSON.stringify({
            event: 'agent.turn_abandoned',
            tenant: tenantId,
            conversation: conversationId,
            turn: open.id,
            reason: mine ? 'RETRIED' : 'LEASE_EXPIRED',
          }),
        );
      }

      const batch = await selectInboundBatch(
        tx,
        tenantId,
        initial.channelAccountId,
        conversationId,
      );
      if (!batch) return { kind: 'none', reason: 'NOTHING_PENDING' };

      const conversation = await tx.conversation.findFirst({
        where: { tenantId, id: conversationId },
        select: {
          state: true,
          version: true,
          channelAccountId: true,
          providerChatId: true,
        },
      });
      if (!conversation || conversation.state !== 'BOT_ACTIVE') {
        // The operator owns the conversation: close the batch, no reply, and
        // pass the customer's messages on to the operators.
        if (
          conversation?.state === 'WAITING_OPERATOR' ||
          conversation?.state === 'OPERATOR_ACTIVE'
        ) {
          await tx.outboxEvent.createMany({
            data: batch.messages.map((message) => ({
              tenantId,
              type: 'handover.forward',
              aggregateType: 'message',
              aggregateId: message.id,
              idempotencyKey: `handover.forward:${message.id}`,
              payload: {
                messageId: message.id,
              } satisfies Prisma.InputJsonObject,
            })),
            skipDuplicates: true,
          });
        }
        await tx.inboundEvent.updateMany({
          where: {
            tenantId,
            id: { in: [...batch.eventIds] },
            status: 'RECEIVED',
          },
          data: { status: 'PROCESSED', processedAt: now },
        });
        return { kind: 'none', reason: 'NOT_BOT_ACTIVE' };
      }

      const latestInbound = await tx.message.findFirst({
        where: { tenantId, conversationId, direction: 'INBOUND' },
        orderBy: { sequence: 'desc' },
        select: { sequence: true },
      });
      const sequences = batch.messages.map((message) => message.sequence);
      const answeredSequence = Math.max(...sequences);
      const idempotencyKey = `agent-reply:${conversationId}:${answeredSequence}`;
      const committed = await tx.agentTurn.findFirst({
        where: { tenantId, idempotencyKey, status: 'COMMITTED' },
        select: { id: true },
      });
      if (committed) {
        // Already answered (e.g. events reset by an operator tool): close.
        await tx.inboundEvent.updateMany({
          where: {
            tenantId,
            id: { in: [...batch.eventIds] },
            status: 'RECEIVED',
          },
          data: { status: 'PROCESSED', processedAt: now },
        });
        return { kind: 'none', reason: 'ALREADY_ANSWERED' };
      }
      const attempts = await tx.agentTurn.count({
        where: { tenantId, idempotencyKey },
      });
      await tx.inboundEvent.updateMany({
        where: {
          tenantId,
          id: { in: [...batch.eventIds] },
          status: 'RECEIVED',
        },
        data: { status: 'PROCESSING' },
      });
      const correlationId = randomUUID();
      const turn = await tx.agentTurn.create({
        data: {
          tenantId,
          conversationId,
          channelAccountId: conversation.channelAccountId,
          idempotencyKey,
          attempt: attempts + 1,
          mode,
          status: 'COMPUTING',
          claimToken: event.outboxId,
          leaseExpiresAt: new Date(now.getTime() + leaseMs),
          answeredSequence,
          seenInboundSequence: Math.max(
            answeredSequence,
            latestInbound?.sequence ?? answeredSequence,
          ),
          conversationVersion: conversation.version,
          inboundEventIds: [...batch.eventIds],
          correlationId,
          startedAt: now,
        },
        select: { id: true },
      });
      return {
        kind: 'claimed',
        claim: {
          turnId: turn.id,
          correlationId,
          mode,
          conversationVersion: conversation.version,
          channelAccountId: conversation.channelAccountId,
          providerChatId: conversation.providerChatId,
          eventIds: batch.eventIds,
          firstSequence: Math.min(...sequences),
          answeredSequence,
          idempotencyKey,
          text: batch.text,
        },
      };
    });
  }

  /** Compute threw: record the attempt and release (or close) its batch. */
  private async fail(
    tenantId: string,
    conversationId: string,
    claim: Claim,
    error: unknown,
  ): Promise<void> {
    const configuration = error instanceof AgentConfigurationError;
    await this.prisma.$transaction(async (tx) => {
      await lockConversation(tx, tenantId, conversationId);
      const updated = await tx.agentTurn.updateMany({
        where: { id: claim.turnId, tenantId, status: 'COMPUTING' },
        data: {
          status: 'FAILED',
          failureCode: configuration
            ? 'CONFIGURATION'
            : redactPii((error as Error)?.name ?? 'Error', 100),
          completedAt: new Date(),
        },
      });
      if (updated.count === 0) return;
      // A configuration error will not fix itself on retry: close the batch.
      // Anything else is retried by the queue with the batch released.
      await tx.inboundEvent.updateMany({
        where: {
          tenantId,
          id: { in: [...claim.eventIds] },
          status: 'PROCESSING',
        },
        data: configuration
          ? { status: 'PROCESSED', processedAt: new Date() }
          : { status: 'RECEIVED' },
      });
    });
    this.logger.error(
      JSON.stringify({
        event: 'agent.turn_failed',
        tenant: tenantId,
        conversation: conversationId,
        turn: claim.turnId,
        correlationId: claim.correlationId,
        name: (error as Error)?.name,
        retry: !configuration,
      }),
    );
  }

  async commit(
    tenantId: string,
    conversationId: string,
    claim: Claim,
    computed: ComputedTurn,
  ): Promise<CommitResult> {
    const metrics = turnMetrics(computed);
    return this.prisma.$transaction(async (tx): Promise<CommitResult> => {
      await lockConversation(tx, tenantId, conversationId);
      const now = new Date();
      const turn = await tx.agentTurn.findFirst({
        where: { id: claim.turnId, tenantId },
        select: { status: true, seenInboundSequence: true },
      });
      // Taken over after lease expiry or superseded by a retry: drop.
      if (!turn || turn.status !== 'COMPUTING') return 'LOST';

      const conversation = await tx.conversation.findFirst({
        where: { tenantId, id: conversationId },
        select: { state: true, version: true },
      });
      if (
        !conversation ||
        conversation.state !== 'BOT_ACTIVE' ||
        conversation.version !== claim.conversationVersion
      ) {
        await tx.agentTurn.update({
          where: { id: claim.turnId },
          data: {
            ...metrics,
            status: 'DISCARDED',
            discardReason: 'STATE_CHANGED',
            completedAt: now,
          },
        });
        await tx.inboundEvent.updateMany({
          where: {
            tenantId,
            id: { in: [...claim.eventIds] },
            status: 'PROCESSING',
          },
          data: { status: 'PROCESSED', processedAt: now },
        });
        return 'STATE_CHANGED';
      }

      const newest = await tx.message.findFirst({
        where: { tenantId, conversationId, direction: 'INBOUND' },
        orderBy: { sequence: 'desc' },
        select: { sequence: true },
      });
      if ((newest?.sequence ?? 0) > turn.seenInboundSequence) {
        await tx.agentTurn.update({
          where: { id: claim.turnId },
          data: {
            ...metrics,
            status: 'DISCARDED',
            discardReason: 'SUPERSEDED',
            completedAt: now,
          },
        });
        await tx.inboundEvent.updateMany({
          where: {
            tenantId,
            id: { in: [...claim.eventIds] },
            status: 'PROCESSING',
          },
          data: { status: 'RECEIVED' },
        });
        return 'SUPERSEDED';
      }

      await this.agent.applyTurnState(tx, tenantId, conversationId, computed);
      await tx.inboundEvent.updateMany({
        where: {
          tenantId,
          id: { in: [...claim.eventIds] },
          status: 'PROCESSING',
        },
        data: { status: 'PROCESSED', processedAt: now },
      });

      const { result } = computed;
      let replyMessageId: string | undefined;
      let handoverId: string | undefined;
      if (claim.mode === 'LIVE') {
        const latest = await tx.message.findFirst({
          where: { tenantId, conversationId },
          orderBy: { sequence: 'desc' },
          select: { sequence: true },
        });
        const reply = await tx.message.create({
          data: {
            tenantId,
            conversationId,
            channelAccountId: claim.channelAccountId,
            authorType: 'BOT',
            direction: 'OUTBOUND',
            type: 'TEXT',
            text: result.reply.slice(0, 4_096),
            sequence: (latest?.sequence ?? 0) + 1,
            providerChatId: claim.providerChatId,
            deliveryState: 'PENDING',
            sendIdempotencyKey: claim.idempotencyKey,
          },
          select: { id: true },
        });
        replyMessageId = reply.id;
        await tx.outboxEvent.create({
          data: {
            tenantId,
            type: 'telegram.send',
            aggregateType: 'message',
            aggregateId: reply.id,
            idempotencyKey: `telegram.send:${reply.id}`,
            payload: { messageId: reply.id } satisfies Prisma.InputJsonObject,
          },
        });
        if (result.outcome === 'HANDOVER' && result.handover) {
          handoverId = await this.handoverService.openHandover(tx, {
            tenantId,
            conversationId,
            reason: result.handover,
            summary: handoverSummary(computed),
            idempotencyKey: `handover:${claim.idempotencyKey}`,
            conversationVersion: claim.conversationVersion,
            slaMinutes:
              this.config.get('HANDOVER_SLA_MINUTES', { infer: true }) ?? 10,
            now,
          });
          if (handoverId) {
            this.logger.warn(
              JSON.stringify({
                event: 'handover.opened',
                tenant: tenantId,
                conversation: conversationId,
                handover: handoverId,
                reason: result.handover,
                // Recorded and queued for the operator group; whether anyone
                // was reached is the handover's notificationStatus.
                note: 'operator notification is queued, not yet delivered',
              }),
            );
          }
        }
      }

      if (claim.mode === 'LIVE') {
        // A phone number the customer wrote is kept on the contact, never
        // guessed; then the lead is re-scored from this turn's evidence.
        const phone = extractPhone(claim.text);
        const conversationRow = await tx.conversation.findFirst({
          where: { tenantId, id: conversationId },
          select: { contactId: true },
        });
        if (phone && conversationRow)
          await this.leadService.capturePhone(
            tx,
            tenantId,
            conversationRow.contactId,
            phone,
          );
        await this.leadService.rescoreFromTurn(tx, {
          tenantId,
          conversationId,
          slots: result.slots,
          ...(result.intent ? { intent: result.intent } : {}),
        });
      }

      await tx.agentTurn.update({
        where: { id: claim.turnId },
        data: {
          ...metrics,
          status: 'COMMITTED',
          replyMessageId,
          handoverId,
          completedAt: now,
        },
      });
      return 'COMMITTED';
    });
  }
}

/** Turn record fields derived from a computed turn (no raw customer text). */
export function turnMetrics(
  computed: ComputedTurn,
): Prisma.AgentTurnUpdateInput {
  const { result, usage } = computed;
  const sum = (pick: (entry: (typeof usage)[number]) => number): number =>
    usage.reduce((total, entry) => total + pick(entry), 0);
  return {
    outcome: result.outcome,
    handoverReason: result.outcome === 'HANDOVER' ? result.handover : null,
    failureCode: result.llmFailure ?? null,
    locale: result.locale,
    provider: computed.providerId,
    models: [...new Set(usage.map((entry) => entry.model))],
    llmCalls: usage.length,
    inputTokens: sum(
      (entry) =>
        entry.usage.inputTokens +
        entry.usage.cacheReadTokens +
        entry.usage.cacheWrite5mTokens +
        entry.usage.cacheWrite1hTokens,
    ),
    outputTokens: sum((entry) => entry.usage.outputTokens),
    estimatedCostNano: BigInt(sum((entry) => entry.reservedNano)),
    actualCostNano: BigInt(sum((entry) => entry.costNano)),
    latencyMs: computed.latencyMs,
    toolCalls: result.tools.map((tool) => ({
      name: tool.name,
      origin: tool.origin,
      status: tool.status,
      outcome: tool.outcome,
      ...(tool.code ? { code: tool.code } : {}),
      input: tool.input,
      durationMs: tool.durationMs,
    })),
    guardrail: {
      violations: [...result.violations],
      regenerated: result.regenerated,
      ...(result.extractionFailure
        ? { extractionFailure: result.extractionFailure }
        : {}),
      ...(result.budgetStop ? { budgetStop: result.budgetStop } : {}),
      timedOut: computed.timedOut,
    },
    shownFactIds: [...result.shownFactIds],
    askedSlot: result.askedSlot ?? null,
    slotsFilled: Object.keys(result.slots).length,
    textFingerprint: result.textFingerprint,
    facts: result.facts.map((fact) => ({
      id: fact.id,
      value: fact.value,
      provenance: fact.provenance,
    })) as unknown as Prisma.InputJsonValue,
    draftText: result.reply,
    pricingVersion: computed.pricingVersion,
    promptVersion: computed.promptVersion,
    packRef: computed.packRef,
  };
}

/** Structured handover summary (HandoverSummarySchema); no raw messages. */
export function handoverSummary(computed: ComputedTurn): HandoverSummary {
  const { result } = computed;
  return {
    verifiedFacts: result.facts.map(
      (fact) =>
        `${fact.value.kind}: ${JSON.stringify(fact.value)} [${fact.provenance.sourceSystem}/${fact.provenance.sourceEntityId} @ ${fact.provenance.retrievedAt}]`,
    ),
    customerClaims: Object.entries(result.slots).map(
      ([key, entry]) => `${key}=${redactPii(String(entry.value), 80)}`,
    ),
    inferences: [
      ...(result.intent ? [`intent=${result.intent}`] : []),
      `locale=${result.locale}`,
    ],
    unknowns: [
      `reason=${result.handover ?? 'none'}`,
      ...(result.llmFailure ? [`llmFailure=${result.llmFailure}`] : []),
      ...(result.budgetStop ? [`budgetStop=${result.budgetStop}`] : []),
      ...result.violations.map((violation) => `guardrail=${violation}`),
    ],
  };
}
