import { Injectable } from '@nestjs/common';
import type { SchedulingPort } from '../core/scheduling/scheduling-port.js';
import type {
  PendingScheduling,
  SchedulingOperation,
} from '../core/scheduling/scheduling-render.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../persistence/prisma.service.js';
import { AppointmentService } from './appointment.service.js';
import { AppointmentSchedulingPort } from './scheduling-port.adapter.js';

type Tx = Prisma.TransactionClient;

export const SCHEDULING_ACTION_PREFIX = 'scheduling.';

/** Stored with a scheduling proposal; identifies the appointments involved. */
export interface SchedulingPayload {
  readonly appointmentId: string;
  readonly replacesAppointmentId?: string;
}

export type SchedulingExecution =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: 'holdExpired' | 'notAvailableAnymore';
    };

export function isSchedulingOperation(operation: string): boolean {
  return operation.startsWith(SCHEDULING_ACTION_PREFIX);
}

function payloadOf(raw: unknown): SchedulingPayload | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const { appointmentId, replacesAppointmentId } = raw as Record<
    string,
    unknown
  >;
  if (typeof appointmentId !== 'string') return undefined;
  return {
    appointmentId,
    ...(typeof replacesAppointmentId === 'string'
      ? { replacesAppointmentId }
      : {}),
  };
}

function operationOf(operation: string): SchedulingOperation | undefined {
  const name = operation.slice(SCHEDULING_ACTION_PREFIX.length);
  return name === 'book' || name === 'cancel' || name === 'reschedule'
    ? name
    : undefined;
}

/**
 * Scheduling for the agent (ADR 046 step 2): builds the per-turn port and
 * applies a confirmed change inside the pipeline's commit transaction.
 * Every query is tenant-scoped; ownership is checked through the
 * conversation's contact, never from model output.
 */
@Injectable()
export class SchedulingActionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly appointments: AppointmentService,
  ) {}

  /**
   * The scheduling port of one turn, or undefined when the tenant has no
   * active service type or staff member (the tools are then not offered).
   */
  async portFor(input: {
    tenantId: string;
    conversationId: string;
    turnKey: string;
    timeZone: string;
    now?: () => Date;
  }): Promise<SchedulingPort | undefined> {
    const { tenantId, conversationId } = input;
    const [conversation, services, staff] = await Promise.all([
      this.prisma.conversation.findFirst({
        where: { tenantId, id: conversationId },
        select: { contactId: true },
      }),
      this.prisma.serviceType.findMany({
        where: { tenantId, active: true },
        orderBy: { key: 'asc' },
        select: { id: true, key: true, title: true },
      }),
      this.prisma.staffMember.count({ where: { tenantId, active: true } }),
    ]);
    if (!conversation || services.length === 0 || staff === 0) return undefined;
    return new AppointmentSchedulingPort(
      this.prisma,
      this.appointments,
      {
        tenantId,
        conversationId,
        contactId: conversation.contactId,
        turnKey: input.turnKey,
        timeZone: input.timeZone,
        now: input.now ?? ((): Date => new Date()),
      },
      services,
    );
  }

  /** What the customer is asked to confirm, for the reply to their next message. */
  async pendingView(
    tenantId: string,
    operation: string,
    rawPayload: unknown,
  ): Promise<PendingScheduling | undefined> {
    const op = operationOf(operation);
    const payload = payloadOf(rawPayload);
    if (!op || !payload) return undefined;
    const row = await this.prisma.appointment.findFirst({
      where: { tenantId, id: payload.appointmentId },
      include: { serviceType: true, staffMember: true },
    });
    if (!row) return undefined;
    const previous = payload.replacesAppointmentId
      ? await this.prisma.appointment.findFirst({
          where: { tenantId, id: payload.replacesAppointmentId },
          select: { startsAt: true },
        })
      : null;
    return {
      operation: op,
      view: {
        serviceTitle: row.serviceType.title,
        staffName: row.staffMember.displayName,
        startsAtIso: row.startsAt.toISOString(),
        ...(previous
          ? { previousStartsAtIso: previous.startsAt.toISOString() }
          : {}),
      },
    };
  }

  /** The customer declined or the proposal was replaced: free the held time. */
  async release(
    tx: Tx,
    input: { tenantId: string; operation: string; payload: unknown },
  ): Promise<void> {
    const op = operationOf(input.operation);
    const payload = payloadOf(input.payload);
    if (!payload || (op !== 'book' && op !== 'reschedule')) return;
    await tx.appointment.updateMany({
      where: {
        tenantId: input.tenantId,
        id: payload.appointmentId,
        status: 'HELD',
      },
      data: { status: 'CANCELLED', holdExpiresAt: null },
    });
  }

  /**
   * Applies a confirmed change. A reschedule confirms the new appointment and
   * cancels the old one in the caller's transaction, so the customer is never
   * left with neither (nor, by the exclusion constraint, with a double slot).
   */
  async execute(
    tx: Tx,
    input: {
      tenantId: string;
      conversationId: string;
      operation: string;
      payload: unknown;
      now: Date;
    },
  ): Promise<SchedulingExecution> {
    const { tenantId, conversationId, now } = input;
    const op = operationOf(input.operation);
    const payload = payloadOf(input.payload);
    if (!op || !payload) return { ok: false, reason: 'notAvailableAnymore' };
    const conversation = await tx.conversation.findFirst({
      where: { tenantId, id: conversationId },
      select: { contactId: true },
    });
    if (!conversation) return { ok: false, reason: 'notAvailableAnymore' };
    const { contactId } = conversation;

    if (op === 'cancel') {
      const done = await tx.appointment.updateMany({
        where: {
          tenantId,
          id: payload.appointmentId,
          contactId,
          status: 'CONFIRMED',
          startsAt: { gt: now },
        },
        data: { status: 'CANCELLED', holdExpiresAt: null },
      });
      return done.count === 1
        ? { ok: true }
        : { ok: false, reason: 'notAvailableAnymore' };
    }

    const confirmed = await tx.appointment.updateMany({
      where: {
        tenantId,
        id: payload.appointmentId,
        contactId,
        status: 'HELD',
        holdExpiresAt: { gt: now },
      },
      data: { status: 'CONFIRMED', holdExpiresAt: null },
    });
    if (confirmed.count !== 1) {
      await tx.appointment.updateMany({
        where: {
          tenantId,
          id: payload.appointmentId,
          status: 'HELD',
          holdExpiresAt: { lte: now },
        },
        data: { status: 'EXPIRED' },
      });
      return { ok: false, reason: 'holdExpired' };
    }
    if (op === 'reschedule' && payload.replacesAppointmentId) {
      await tx.appointment.updateMany({
        where: {
          tenantId,
          id: payload.replacesAppointmentId,
          contactId,
          status: 'CONFIRMED',
        },
        data: { status: 'CANCELLED', holdExpiresAt: null },
      });
    }
    return { ok: true };
  }
}
