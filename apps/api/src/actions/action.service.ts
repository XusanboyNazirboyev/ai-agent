import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  TenantConfigSchema,
  type ActionSpec,
  type DomainPack,
} from '@agentcore/shared';
import type { AppEnvironment } from '../config/environment.js';
import type {
  CrmConnector,
  WriteIdempotency,
} from '../connectors/interfaces/crm-connector.js';
import { writeExecutionOf } from '../connectors/interfaces/errors.js';
import {
  ConnectorOperations,
  dueRetries,
  type ClaimedOperation,
  type OperationRef,
} from '../connectors/operations/connector-operations.js';
import {
  afterFailure,
  beforeAttempt,
} from '../connectors/operations/write-policy.js';
import { TenantConnectorLoader } from '../connectors/sync/tenant-connector-loader.js';
import {
  ACTION_SLOT_PREFIX,
  sendsContactData,
  type ActionCandidate,
  type ActionDecision,
  type ActionTurnContext,
} from '../core/actions/actions.js';
import type {
  HandoverReason,
  LocalePack,
} from '../core/locales/locale-pack.js';
import { Prisma } from '../generated/prisma/client.js';
import { lockConversation } from '../handover/conversation-lock.js';
import { HandoverService } from '../handover/handover.service.js';
import { extractPhone } from '../leads/phone.js';
import { INITIAL_LOCALE_PACKS } from '../locales/locale-packs.js';
import { DOMAIN_PACKS } from '../packs/registry.js';
import { PrismaService } from '../persistence/prisma.service.js';

type Tx = Prisma.TransactionClient;

export const ACTION_SUBJECT = 'action_proposal';
export const MAX_ACTION_ATTEMPTS = 6;
/** Longer than any connector deadline (max 300 s); see ADR 023. */
export const ACTION_LEASE_MS = 10 * 60_000;
const actionRetryDelayMs = (attempts: number): number =>
  Math.min(3_600_000, 30_000 * 2 ** Math.max(0, attempts - 1));

/** A plausible personal name: letters, spaces, apostrophes, hyphens; 2-60 characters. */
export function nameFrom(text: string): string | undefined {
  const trimmed = text.trim().replace(/\s+/gu, ' ');
  return /^[\p{L}][\p{L} 'ʻʼ‘’-]{1,59}$/u.test(trimmed) ? trimmed : undefined;
}

export type ExecuteResult =
  'SUCCEEDED' | 'FAILED' | 'UNCERTAIN' | 'RETRY_WAIT' | 'CANCELLED' | 'SKIPPED';

const PROTECTED: readonly WriteIdempotency[] = ['native', 'lookup'];

/**
 * Business actions (ADR 024) around the generic core logic: which actions a
 * tenant may use now, what a turn's decision does in the commit transaction,
 * and durable execution through the connector-operation store (ADR 023).
 * Every query is tenant-scoped; execution re-checks every authorization.
 */
@Injectable()
export class ActionService {
  private readonly logger = new Logger(ActionService.name);
  private readonly operations: ConnectorOperations;

  constructor(
    private readonly prisma: PrismaService,
    private readonly loader: TenantConnectorLoader,
    private readonly handovers: HandoverService,
    @Optional() private readonly config?: ConfigService<AppEnvironment, true>,
  ) {
    this.operations = new ConnectorOperations(prisma);
  }

  private async writeConnector(
    tenantId: string,
    operation: ActionSpec['operation'],
  ): Promise<CrmConnector | undefined> {
    const rows = await this.prisma.tenantConnector.findMany({
      where: { tenantId, status: 'ACTIVE' },
      orderBy: { createdAt: 'asc' },
    });
    for (const row of rows) {
      try {
        const connector = this.loader.create(row);
        if (
          connector.capabilities[operation] &&
          typeof connector[operation] === 'function'
        )
          return connector;
      } catch {
        // An unusable connector configuration is skipped.
      }
    }
    return undefined;
  }

  /**
   * Actions usable right now: declared by the pack, `live` in tenant config,
   * a connector with the capability, idempotency protection unless the tenant
   * explicitly allows an unprotected connector (D-2), and consent text when
   * contact data is sent (D-5). Empty = nothing to offer.
   */
  async available(
    tenantId: string,
    pack: DomainPack,
  ): Promise<{ candidates: ActionCandidate[]; connector?: CrmConnector }> {
    if (pack.actions.length === 0) return { candidates: [] };
    const tenant = await this.prisma.tenant.findFirst({
      where: { id: tenantId, status: 'ACTIVE' },
      select: { config: true },
    });
    const parsed = TenantConfigSchema.safeParse(tenant?.config ?? {});
    const settings = parsed.success ? (parsed.data.actions ?? {}) : {};
    const enabled = pack.actions.filter(
      (spec) => settings[spec.key]?.mode === 'live',
    );
    if (enabled.length === 0) return { candidates: [] };
    const candidates: ActionCandidate[] = [];
    let connector: CrmConnector | undefined;
    for (const spec of enabled) {
      const setting = settings[spec.key]!;
      const writer = await this.writeConnector(tenantId, spec.operation);
      if (!writer) continue;
      const mode = writer.writeIdempotency ?? 'none';
      if (!PROTECTED.includes(mode) && !setting.allowUnprotectedConnector)
        continue;
      if (sendsContactData(spec)) {
        const consent = setting.consent ?? {};
        if (!pack.locales.every((locale) => consent[locale])) continue;
        candidates.push({ spec, consent });
      } else candidates.push({ spec });
      connector ??= writer;
    }
    return { candidates, ...(connector ? { connector } : {}) };
  }

  /** The action context of one turn; undefined when no action applies. */
  async turnContext(input: {
    tenantId: string;
    conversationId: string;
    pack: DomainPack;
    packRef: string;
    contact: { name?: string | null; phone?: string | null };
    customerText: string;
    now?: Date;
  }): Promise<ActionTurnContext | undefined> {
    const now = input.now ?? new Date();
    const { candidates } = await this.available(input.tenantId, input.pack);
    const pending = await this.prisma.actionProposal.findFirst({
      where: {
        tenantId: input.tenantId,
        conversationId: input.conversationId,
        status: 'PROPOSED',
        expiresAt: { gt: now },
      },
      select: { id: true, actionKey: true, digest: true },
    });
    if (candidates.length === 0 && !pending) return undefined;
    const last = await this.prisma.agentTurn.findFirst({
      where: {
        tenantId: input.tenantId,
        conversationId: input.conversationId,
        status: 'COMMITTED',
      },
      orderBy: { completedAt: 'desc' },
      select: { askedSlot: true },
    });
    const asked = last?.askedSlot?.startsWith(ACTION_SLOT_PREFIX)
      ? last.askedSlot.slice(ACTION_SLOT_PREFIX.length).split(':')
      : undefined;
    const collecting = asked?.[0];
    const phone = input.contact.phone ?? extractPhone(input.customerText);
    // A reply to the action's own name question is the name, if it looks like
    // one (letters, spaces, apostrophes, hyphens; 2-60 characters). It is used
    // for this proposal only and not stored on the contact.
    const answeredName =
      asked?.[1] === 'contact.name' &&
      /^[\p{L}][\p{L}\s'ʻʼ‘’-]{1,59}$/u.test(input.customerText.trim())
        ? input.customerText.trim().replace(/\s+/gu, ' ')
        : undefined;
    const name = input.contact.name ?? answeredName;
    return {
      available: candidates,
      // A pending proposal of an action that is no longer available is not offered for confirmation.
      ...(pending && candidates.some((c) => c.spec.key === pending.actionKey)
        ? { pending }
        : {}),
      ...(collecting ? { collecting } : {}),
      contact: {
        ...(name ? { name } : {}),
        ...(phone ? { phone } : {}),
      },
      scope: {
        tenantId: input.tenantId,
        conversationId: input.conversationId,
        packRef: input.packRef,
      },
    };
  }

  /**
   * LIVE commit step: a name written in answer to an action's name question
   * is kept on the contact when it has none (never overwritten, never guessed).
   */
  async captureName(
    tx: Tx,
    tenantId: string,
    conversationId: string,
    customerText: string,
  ): Promise<void> {
    const name = nameFrom(customerText);
    if (!name) return;
    const last = await tx.agentTurn.findFirst({
      where: { tenantId, conversationId, status: 'COMMITTED' },
      orderBy: { completedAt: 'desc' },
      select: { askedSlot: true },
    });
    if (
      !last?.askedSlot?.startsWith(ACTION_SLOT_PREFIX) ||
      !last.askedSlot.endsWith(':contact.name')
    )
      return;
    const conversation = await tx.conversation.findFirst({
      where: { tenantId, id: conversationId },
      select: { contactId: true },
    });
    if (!conversation) return;
    await tx.contact.updateMany({
      where: { tenantId, id: conversation.contactId, name: null },
      data: { name },
    });
  }

  private audit(
    tx: Tx,
    tenantId: string,
    proposalId: string,
    action: string,
    summary: Prisma.InputJsonObject,
    key?: string,
  ): Promise<unknown> {
    return tx.auditEvent.create({
      data: {
        tenantId,
        actorType:
          action === 'action.confirmed' || action === 'action.declined'
            ? 'CUSTOMER'
            : 'SYSTEM',
        action,
        entityType: 'action_proposal',
        entityId: proposalId,
        safeInputSummary: summary,
        ...(key ? { idempotencyKey: key } : {}),
      },
    });
  }

  /**
   * Applies a LIVE turn's decision inside the pipeline's commit transaction.
   * Returns `expired` when a confirmation arrived for a proposal that is no
   * longer open (expired, superseded, changed): the reply must then say so.
   */
  async applyDecision(
    tx: Tx,
    input: {
      tenantId: string;
      conversationId: string;
      decision: ActionDecision;
      packRef: string;
      turnKey: string;
      now: Date;
    },
  ): Promise<{ expired?: true }> {
    const { tenantId, conversationId, decision, now } = input;
    const supersede = async (proposalId: string): Promise<void> => {
      const changed = await tx.actionProposal.updateMany({
        where: { tenantId, conversationId, id: proposalId, status: 'PROPOSED' },
        data: {
          status: 'SUPERSEDED',
          payload: Prisma.DbNull,
          payloadClearedAt: now,
        },
      });
      if (changed.count === 1)
        await this.audit(tx, tenantId, proposalId, 'action.superseded', {});
    };
    if (decision.kind === 'SUPERSEDE') {
      await supersede(decision.proposalId);
      return {};
    }
    if (decision.kind === 'DECLINE') {
      const changed = await tx.actionProposal.updateMany({
        where: {
          tenantId,
          conversationId,
          id: decision.proposalId,
          status: 'PROPOSED',
        },
        data: {
          status: 'DECLINED',
          payload: Prisma.DbNull,
          payloadClearedAt: now,
        },
      });
      if (changed.count === 1)
        await this.audit(
          tx,
          tenantId,
          decision.proposalId,
          'action.declined',
          {},
        );
      return {};
    }
    if (decision.kind === 'PROPOSE') {
      const open = await tx.actionProposal.findMany({
        where: { tenantId, conversationId, status: 'PROPOSED' },
        select: { id: true },
      });
      for (const row of open) await supersede(row.id);
      const pack = DOMAIN_PACKS.get(input.packRef);
      const spec = pack?.actions.find(
        (action) => action.key === decision.actionKey,
      );
      if (!spec) return {};
      const created = await tx.actionProposal.create({
        data: {
          tenantId,
          conversationId,
          actionKey: spec.key,
          operation: spec.operation,
          packRef: input.packRef,
          payload: decision.payload as Prisma.InputJsonObject,
          digest: decision.digest,
          expiresAt: new Date(
            now.getTime() + decision.expiresAfterMinutes * 60_000,
          ),
          proposedTurnKey: input.turnKey,
        },
        select: { id: true },
      });
      // Field names only: values are customer data and stay out of audit.
      await this.audit(tx, tenantId, created.id, 'action.proposed', {
        actionKey: spec.key,
        fields: Object.keys(decision.payload).sort(),
      });
      return {};
    }
    // CONFIRM: only the exact open proposal, same digest, not expired.
    const confirmed = await tx.actionProposal.updateMany({
      where: {
        tenantId,
        conversationId,
        id: decision.proposalId,
        status: 'PROPOSED',
        digest: decision.digest,
        expiresAt: { gt: now },
      },
      data: { status: 'CONFIRMED', confirmedAt: now },
    });
    if (confirmed.count !== 1) return { expired: true };
    const proposal = await tx.actionProposal.findFirstOrThrow({
      where: { tenantId, id: decision.proposalId },
      select: { operation: true, actionKey: true },
    });
    const ref = this.ref(tenantId, decision.proposalId, proposal.operation);
    await tx.connectorOperation.createMany({
      data: [{ ...ref, idempotencyKey: ConnectorOperations.keyFor(ref) }],
      skipDuplicates: true,
    });
    await tx.outboxEvent.createMany({
      data: [
        {
          tenantId,
          type: 'action.execute',
          aggregateType: 'action_proposal',
          aggregateId: decision.proposalId,
          idempotencyKey: `action.execute:${decision.proposalId}`,
          payload: {
            proposalId: decision.proposalId,
          } satisfies Prisma.InputJsonObject,
        },
      ],
      skipDuplicates: true,
    });
    await this.audit(
      tx,
      tenantId,
      decision.proposalId,
      'action.confirmed',
      { actionKey: proposal.actionKey },
      `action.confirmed:${decision.proposalId}`,
    );
    return {};
  }

  private ref(
    tenantId: string,
    proposalId: string,
    operation: string,
  ): OperationRef {
    return {
      tenantId,
      kind: operation,
      subjectType: ACTION_SUBJECT,
      subjectId: proposalId,
    };
  }

  private localeFor(
    language: string | null,
    script: string | null,
    fallback: string,
  ): LocalePack {
    return (
      INITIAL_LOCALE_PACKS.find(
        (pack) => pack.language === language && pack.script === script,
      ) ??
      INITIAL_LOCALE_PACKS.find((pack) => pack.id === fallback) ??
      INITIAL_LOCALE_PACKS[0]
    );
  }

  /**
   * Executes one confirmed proposal (outbox `action.execute`, or a due retry
   * or abandoned attempt found by the scan). Authorization and policy are
   * checked again here: a tenant that switched the action off, a connector
   * that lost the capability or protection, or a channel account no longer
   * LIVE cancels the action without any external write.
   */
  async execute(
    tenantId: string,
    proposalId: string,
    now = new Date(),
  ): Promise<ExecuteResult> {
    const proposal = await this.prisma.actionProposal.findFirst({
      where: { tenantId, id: proposalId },
      include: {
        conversation: {
          select: {
            channelAccountId: true,
            contactId: true,
            channelAccount: { select: { agentMode: true, status: true } },
          },
        },
      },
    });
    if (!proposal || proposal.status !== 'CONFIRMED') return 'SKIPPED';
    const pack = DOMAIN_PACKS.get(proposal.packRef);
    const spec = pack?.actions.find(
      (action) => action.key === proposal.actionKey,
    );
    const { candidates, connector } = pack
      ? await this.available(tenantId, pack)
      : { candidates: [], connector: undefined };
    const authorized =
      spec !== undefined &&
      connector !== undefined &&
      candidates.some((candidate) => candidate.spec.key === spec.key) &&
      proposal.conversation.channelAccount.agentMode === 'LIVE' &&
      proposal.conversation.channelAccount.status === 'ACTIVE';
    const ref = this.ref(tenantId, proposalId, proposal.operation);
    if (!authorized) {
      // Policy revoked between confirmation and execution: never write. If no
      // attempt could have reached the system, cancel; if one may have, the
      // outcome is unknown and a person decides.
      const result = await this.prisma.$transaction(
        async (tx): Promise<ExecuteResult> => {
          const op = await tx.connectorOperation.findFirst({ where: ref });
          if (!op) return 'SKIPPED';
          const leaseLive =
            op.status === 'IN_FLIGHT' &&
            op.leaseExpiresAt !== null &&
            op.leaseExpiresAt > now;
          if (
            leaseLive ||
            !['PENDING', 'RETRY_WAIT', 'IN_FLIGHT'].includes(op.status)
          )
            return 'SKIPPED';
          const safe =
            op.status === 'PENDING' ||
            (op.status === 'RETRY_WAIT' && op.lastExecution === 'NOT_EXECUTED');
          const changed = await tx.connectorOperation.updateMany({
            where: {
              id: op.id,
              tenantId,
              status: op.status,
              attempts: op.attempts,
            },
            data: safe
              ? {
                  status: 'FAILED',
                  lastErrorCode: 'ACTION_NOT_AUTHORIZED',
                  leaseToken: null,
                  leaseExpiresAt: null,
                  completedAt: now,
                }
              : {
                  status: 'UNCERTAIN',
                  lastExecution: 'UNCERTAIN',
                  lastErrorCode: 'ACTION_NOT_AUTHORIZED',
                  leaseToken: null,
                  leaseExpiresAt: null,
                  completedAt: now,
                },
          });
          if (changed.count !== 1) return 'SKIPPED';
          await this.finishProposal(
            tx,
            proposal.id,
            tenantId,
            {
              status: safe ? 'CANCELLED' : 'UNCERTAIN',
              errorCode: 'ACTION_NOT_AUTHORIZED',
            },
            now,
          );
          await this.tellCustomer(
            tx,
            tenantId,
            proposal.conversationId,
            safe ? 'ACTION_FAILED' : 'ACTION_OUTCOME_UNKNOWN',
            undefined,
            proposal.id,
            now,
          );
          return safe ? 'CANCELLED' : 'UNCERTAIN';
        },
      );
      return result;
    }
    const mode = connector!.writeIdempotency ?? 'none';
    const claim = await this.operations.claim(ref, mode, now, ACTION_LEASE_MS);
    if (!claim.claimed) return 'SKIPPED';
    const op = claim.operation;
    const step = beforeAttempt(op.previous, mode);
    if (step === 'STOP_UNCERTAIN') {
      await this.record(proposal, op, now, {
        status: 'UNCERTAIN',
        execution: 'UNCERTAIN',
        errorCode: op.previous.abandoned
          ? 'ATTEMPT_ABANDONED'
          : 'OUTCOME_UNKNOWN',
      });
      return 'UNCERTAIN';
    }
    const payload = (proposal.payload ?? {}) as Record<string, string>;
    let phase: 'lookup' | 'create' = 'create';
    let externalId: string | undefined;
    try {
      if (step === 'LOOKUP_THEN_ATTEMPT') {
        phase = 'lookup';
        externalId = (
          await connector!.findLeadByIdempotencyKey!(op.idempotencyKey)
        )?.crmLeadId;
        phase = 'create';
      }
      if (externalId === undefined) {
        const slots = Object.fromEntries(
          Object.entries(payload)
            .filter(([name]) => name.startsWith('slots.'))
            .map(([name, value]) => [name.slice('slots.'.length), value]),
        );
        const result = await connector!.createLead!(
          {
            contact: {
              ...(payload['contact.name']
                ? { name: payload['contact.name'] }
                : {}),
              ...(payload['contact.phone']
                ? { phone: payload['contact.phone'] }
                : {}),
            },
            summary: spec!.crmSummary,
            slots,
            reasonCodes: [`ACTION_${spec!.key.toUpperCase()}`.slice(0, 60)],
          },
          { idempotencyKey: op.idempotencyKey },
        );
        externalId = result.crmLeadId;
      }
    } catch (error) {
      const code =
        typeof (error as { code?: unknown })?.code === 'string'
          ? String((error as { code: string }).code).slice(0, 100)
          : ((error as Error)?.name ?? 'UNKNOWN').slice(0, 100);
      const execution =
        phase === 'lookup' ? 'UNCERTAIN' : writeExecutionOf(error);
      const decision = afterFailure(
        execution,
        mode,
        op.attempt,
        MAX_ACTION_ATTEMPTS,
        actionRetryDelayMs,
      );
      await this.record(
        proposal,
        op,
        now,
        decision.status === 'RETRY_WAIT'
          ? {
              status: 'RETRY_WAIT',
              nextAttemptAt: new Date(now.getTime() + decision.delayMs),
              execution,
              errorCode: code,
            }
          : { status: decision.status, execution, errorCode: code },
      );
      this.logger.warn(
        JSON.stringify({
          event: 'action.execution_failed',
          tenant: tenantId,
          proposal: proposalId,
          code,
          execution,
          attempts: op.attempt,
          outcome: decision.status,
        }),
      );
      return decision.status;
    }
    for (let attempt = 1; ; attempt += 1) {
      try {
        await this.record(proposal, op, now, {
          status: 'SUCCEEDED',
          externalId: externalId!,
        });
        return 'SUCCEEDED';
      } catch (error) {
        // Evidence is never turned into a failure; after the lease the
        // abandoned attempt is recovered by idempotency mode (ADR 023).
        if (attempt >= 3) throw error;
        await new Promise((done) => setTimeout(done, 50 * attempt));
      }
    }
  }

  private async finishProposal(
    tx: Tx,
    proposalId: string,
    tenantId: string,
    outcome: {
      status: 'SUCCEEDED' | 'FAILED' | 'UNCERTAIN' | 'CANCELLED';
      externalId?: string;
      errorCode?: string;
    },
    now: Date,
  ): Promise<void> {
    await tx.actionProposal.updateMany({
      where: { tenantId, id: proposalId, status: 'CONFIRMED' },
      data: {
        status: outcome.status,
        outcomeAt: now,
        externalId: outcome.externalId ?? null,
        errorCode: outcome.errorCode ?? null,
        // An UNCERTAIN payload is kept until a person resolves it; otherwise cleared.
        ...(outcome.status === 'UNCERTAIN'
          ? {}
          : { payload: Prisma.DbNull, payloadClearedAt: now }),
      },
    });
    await this.audit(
      tx,
      tenantId,
      proposalId,
      `action.${outcome.status.toLowerCase()}`,
      {
        ...(outcome.errorCode ? { code: outcome.errorCode } : {}),
      },
    );
  }

  /** Operation, proposal, customer message, handover and lead link in one transaction. */
  private async record(
    proposal: {
      id: string;
      tenantId: string;
      conversationId: string;
      actionKey: string;
      packRef: string;
      operation: string;
    },
    op: ClaimedOperation,
    now: Date,
    outcome: Parameters<ConnectorOperations['finish']>[2],
  ): Promise<void> {
    const { tenantId } = proposal;
    await this.prisma.$transaction(async (tx) => {
      const owned = await this.operations.finish(tx, op, outcome, now);
      if (!owned || outcome.status === 'RETRY_WAIT') return;
      if (outcome.status === 'SUCCEEDED') {
        await this.finishProposal(
          tx,
          proposal.id,
          tenantId,
          { status: 'SUCCEEDED', externalId: outcome.externalId },
          now,
        );
        if (proposal.operation === 'createLead') {
          // The conversation's local lead now has a CRM record: the handover
          // lead job must not create a second one.
          await tx.lead.updateMany({
            where: {
              tenantId,
              conversationId: proposal.conversationId,
              crmSyncStatus: { not: 'SYNCED' },
            },
            data: {
              crmSyncStatus: 'SYNCED',
              crmLeadId: outcome.externalId,
              lastErrorCode: null,
              nextAttemptAt: null,
            },
          });
        }
        const spec = DOMAIN_PACKS.get(proposal.packRef)?.actions.find(
          (a) => a.key === proposal.actionKey,
        );
        await this.tellCustomer(
          tx,
          tenantId,
          proposal.conversationId,
          'SUCCEEDED',
          spec?.showExternalReference ? outcome.externalId : undefined,
          proposal.id,
          now,
        );
        return;
      }
      await this.finishProposal(
        tx,
        proposal.id,
        tenantId,
        { status: outcome.status, errorCode: outcome.errorCode },
        now,
      );
      await this.tellCustomer(
        tx,
        tenantId,
        proposal.conversationId,
        outcome.status === 'UNCERTAIN'
          ? 'ACTION_OUTCOME_UNKNOWN'
          : 'ACTION_FAILED',
        undefined,
        proposal.id,
        now,
      );
    });
  }

  /**
   * The customer-facing outcome, rendered by code. Sent only while the bot
   * owns the conversation (an operator speaks for themselves); a failure or
   * an unclear outcome also opens a handover to a person.
   */
  private async tellCustomer(
    tx: Tx,
    tenantId: string,
    conversationId: string,
    outcome: 'SUCCEEDED' | HandoverReason,
    reference: string | undefined,
    proposalId: string,
    now: Date,
  ): Promise<void> {
    await lockConversation(tx, tenantId, conversationId);
    const conversation = await tx.conversation.findFirst({
      where: { tenantId, id: conversationId },
      select: {
        state: true,
        version: true,
        language: true,
        script: true,
        channelAccountId: true,
        providerChatId: true,
        tenant: { select: { defaultLocale: true } },
        channelAccount: { select: { agentMode: true } },
      },
    });
    if (
      !conversation ||
      conversation.state !== 'BOT_ACTIVE' ||
      conversation.channelAccount.agentMode !== 'LIVE'
    )
      return;
    const locale = this.localeFor(
      conversation.language,
      conversation.script,
      conversation.tenant.defaultLocale,
    );
    const text =
      outcome === 'SUCCEEDED'
        ? reference
          ? locale.templates.actions.succeededWithReference.replace(
              '{reference}',
              reference,
            )
          : locale.templates.actions.succeeded
        : locale.templates.handover[outcome];
    const latest = await tx.message.findFirst({
      where: { tenantId, conversationId },
      orderBy: { sequence: 'desc' },
      select: { sequence: true },
    });
    const message = await tx.message.create({
      data: {
        tenantId,
        conversationId,
        channelAccountId: conversation.channelAccountId,
        authorType: 'BOT',
        direction: 'OUTBOUND',
        type: 'TEXT',
        text,
        sequence: (latest?.sequence ?? 0) + 1,
        providerChatId: conversation.providerChatId,
        deliveryState: 'PENDING',
        sendIdempotencyKey: `action.outcome:${proposalId}`,
      },
      select: { id: true },
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
    if (outcome !== 'SUCCEEDED')
      await this.handovers.openHandover(tx, {
        tenantId,
        conversationId,
        reason: outcome,
        summary: {
          verifiedFacts: [],
          customerClaims: [],
          inferences: [`action=${proposalId}`],
          unknowns: [`reason=${outcome}`],
        },
        idempotencyKey: `handover:action:${proposalId}`,
        conversationVersion: conversation.version,
        slaMinutes:
          this.config?.get('HANDOVER_SLA_MINUTES', { infer: true }) ?? 10,
        now,
      });
  }

  /** Scheduled scan: expire stale proposals, re-queue due retries and abandoned attempts. */
  async scanDue(now: Date, limit = 25): Promise<number> {
    const stale = await this.prisma.actionProposal.findMany({
      where: { status: 'PROPOSED', expiresAt: { lte: now } },
      take: limit,
      select: { id: true, tenantId: true },
    });
    for (const row of stale)
      await this.prisma.$transaction(async (tx) => {
        const changed = await tx.actionProposal.updateMany({
          where: { tenantId: row.tenantId, id: row.id, status: 'PROPOSED' },
          data: {
            status: 'EXPIRED',
            payload: Prisma.DbNull,
            payloadClearedAt: now,
          },
        });
        if (changed.count === 1)
          await this.audit(tx, row.tenantId, row.id, 'action.expired', {});
      });
    let queued = 0;
    const kinds = ['createLead'];
    for (const kind of kinds) {
      const due = [
        ...(
          await dueRetries(this.prisma, kind, ACTION_SUBJECT, now, limit)
        ).map((op) => ({ ...op, why: 'retry' })),
        ...(
          await this.operations.abandoned(kind, ACTION_SUBJECT, now, limit)
        ).map((op) => ({ ...op, why: 'recover' })),
      ];
      for (const op of due) {
        const created = await this.prisma.outboxEvent.createMany({
          data: [
            {
              tenantId: op.tenantId,
              type: 'action.execute',
              aggregateType: 'action_proposal',
              aggregateId: op.subjectId,
              idempotencyKey: `action.execute:${op.subjectId}:${op.why}:${op.attempts}`,
              payload: {
                proposalId: op.subjectId,
              } satisfies Prisma.InputJsonObject,
            },
          ],
          skipDuplicates: true,
        });
        queued += created.count;
      }
    }
    return queued + stale.length;
  }

  /**
   * A person checked the connected system for an UNCERTAIN action and records
   * what they found (tenant-scoped, audited). The bot does not message the
   * customer here: the conversation is with an operator after the handover.
   */
  async resolveUncertain(input: {
    tenantId: string;
    proposalId: string;
    outcome: 'SUCCEEDED' | 'FAILED';
    externalId?: string;
    actor: string;
    now?: Date;
  }): Promise<'RESOLVED' | 'NOT_UNCERTAIN' | 'MISSING_EVIDENCE'> {
    const now = input.now ?? new Date();
    const evidence = input.externalId?.trim().slice(0, 200);
    if (input.outcome === 'SUCCEEDED' && !evidence) return 'MISSING_EVIDENCE';
    return this.prisma.$transaction(async (tx) => {
      const proposal = await tx.actionProposal.findFirst({
        where: {
          tenantId: input.tenantId,
          id: input.proposalId,
          status: 'UNCERTAIN',
        },
        select: { operation: true, conversationId: true },
      });
      if (!proposal) return 'NOT_UNCERTAIN';
      const ref = this.ref(
        input.tenantId,
        input.proposalId,
        proposal.operation,
      );
      const changed = await tx.connectorOperation.updateMany({
        where: { ...ref, status: 'UNCERTAIN' },
        data: {
          status:
            input.outcome === 'SUCCEEDED'
              ? 'RESOLVED_SUCCEEDED'
              : 'RESOLVED_FAILED',
          ...(evidence && input.outcome === 'SUCCEEDED'
            ? { externalId: evidence }
            : {}),
          resolvedBy: input.actor.slice(0, 200),
          completedAt: now,
        },
      });
      if (changed.count !== 1) return 'NOT_UNCERTAIN';
      await tx.actionProposal.updateMany({
        where: {
          tenantId: input.tenantId,
          id: input.proposalId,
          status: 'UNCERTAIN',
        },
        data: {
          status: input.outcome,
          externalId: input.outcome === 'SUCCEEDED' ? evidence : null,
          outcomeAt: now,
          payload: Prisma.DbNull,
          payloadClearedAt: now,
        },
      });
      if (input.outcome === 'SUCCEEDED' && proposal.operation === 'createLead')
        await tx.lead.updateMany({
          where: {
            tenantId: input.tenantId,
            conversationId: proposal.conversationId,
            crmSyncStatus: { not: 'SYNCED' },
          },
          data: {
            crmSyncStatus: 'SYNCED',
            crmLeadId: evidence,
            lastErrorCode: null,
            nextAttemptAt: null,
          },
        });
      await tx.auditEvent.create({
        data: {
          tenantId: input.tenantId,
          actorType: 'OPERATOR',
          actorId: input.actor.slice(0, 200),
          action: 'action.resolved',
          entityType: 'action_proposal',
          entityId: input.proposalId,
          safeInputSummary: { outcome: input.outcome },
        },
      });
      return 'RESOLVED';
    });
  }
}
