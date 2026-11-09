import { Injectable } from '@nestjs/common';
import type { Appointment } from '../generated/prisma/client.js';
import { PrismaService } from '../persistence/prisma.service.js';
import {
  HoldExpiredError,
  InvalidAppointmentStateError,
  SchedulingNotFoundError,
  SlotTakenError,
  SlotUnavailableError,
} from './scheduling.errors.js';
import {
  findSlots,
  type BlockedRange,
  type Slot,
  type SlotStaff,
} from './slot-engine.js';

export const DEFAULT_HOLD_MINUTES = 10;
const MAX_WINDOW_DAYS = 31;
const DEFAULT_LIMIT = 20;
const MINUTE = 60_000;

export interface FindSlotsInput {
  serviceTypeId: string;
  from: Date;
  to: Date;
  staffMemberId?: string;
  limit?: number;
  now?: Date;
}

export interface HoldInput {
  serviceTypeId: string;
  staffMemberId: string;
  startsAt: Date;
  contactId: string;
  conversationId?: string;
  idempotencyKey: string;
  holdMinutes?: number;
  now?: Date;
}

type Db = Pick<
  PrismaService,
  | 'tenant'
  | 'serviceType'
  | 'staffMember'
  | 'appointment'
  | 'contact'
  | 'conversation'
>;

/** True when the Postgres exclusion constraint (23P01) rejected the write. */
function isExclusionViolation(error: unknown): boolean {
  const seen = new Set<unknown>();
  const visit = (e: unknown): boolean => {
    if (!e || typeof e !== 'object' || seen.has(e)) return false;
    seen.add(e);
    const o = e as Record<string, unknown>;
    if (o.code === '23P01' || o.originalCode === '23P01') return true;
    if (
      typeof o.message === 'string' &&
      o.message.includes('appointments_no_overlap_excl')
    )
      return true;
    return [o.cause, o.meta, o.driverAdapterError, o.error].some(visit);
  };
  return visit(error);
}

function isUniqueViolation(error: unknown): boolean {
  return (
    !!error &&
    typeof error === 'object' &&
    (error as { code?: unknown }).code === 'P2002'
  );
}

function dateOnly(value: Date | null): string | null {
  return value ? value.toISOString().slice(0, 10) : null;
}

@Injectable()
export class AppointmentService {
  constructor(private readonly prisma: PrismaService) {}

  async findSlots(tenantId: string, input: FindSlotsInput): Promise<Slot[]> {
    const now = input.now ?? new Date();
    const to = new Date(
      Math.min(
        input.to.getTime(),
        input.from.getTime() + MAX_WINDOW_DAYS * 24 * 60 * MINUTE,
      ),
    );
    return this.slotsIn(this.prisma, tenantId, {
      ...input,
      to,
      now,
      limit: input.limit ?? DEFAULT_LIMIT,
    });
  }

  async hold(tenantId: string, input: HoldInput): Promise<Appointment> {
    const now = input.now ?? new Date();
    const holdMinutes = input.holdMinutes ?? DEFAULT_HOLD_MINUTES;
    const existing = await this.byKey(tenantId, input.idempotencyKey);
    if (existing) return existing;
    try {
      return await this.prisma.$transaction(async (tx) => {
        const db = tx as unknown as Db;
        const [contact, conversation] = await Promise.all([
          db.contact.findFirst({
            where: { id: input.contactId, tenantId },
            select: { id: true },
          }),
          input.conversationId
            ? db.conversation.findFirst({
                where: { id: input.conversationId, tenantId },
                select: { id: true },
              })
            : Promise.resolve({ id: '' }),
        ]);
        if (!contact) throw new SchedulingNotFoundError('contact');
        if (!conversation) throw new SchedulingNotFoundError('conversation');

        // Expired holds of this staff member no longer block the slot.
        await db.appointment.updateMany({
          where: {
            tenantId,
            staffMemberId: input.staffMemberId,
            status: 'HELD',
            holdExpiresAt: { lte: now },
          },
          data: { status: 'EXPIRED' },
        });

        const slots = await this.slotsIn(db, tenantId, {
          serviceTypeId: input.serviceTypeId,
          staffMemberId: input.staffMemberId,
          from: input.startsAt,
          to: new Date(input.startsAt.getTime() + 1),
          now,
          limit: 1,
        });
        const slot = slots.find(
          (s) => s.startsAt.getTime() === input.startsAt.getTime(),
        );
        if (!slot) throw new SlotUnavailableError();

        return db.appointment.create({
          data: {
            tenantId,
            serviceTypeId: input.serviceTypeId,
            staffMemberId: input.staffMemberId,
            contactId: input.contactId,
            conversationId: input.conversationId ?? null,
            startsAt: slot.startsAt,
            endsAt: slot.endsAt,
            blockedFrom: slot.blockedFrom,
            blockedUntil: slot.blockedUntil,
            status: 'HELD',
            holdExpiresAt: new Date(now.getTime() + holdMinutes * MINUTE),
            idempotencyKey: input.idempotencyKey,
          },
        });
      });
    } catch (error) {
      if (isExclusionViolation(error)) throw new SlotTakenError();
      if (isUniqueViolation(error)) {
        // A concurrent request with the same idempotency key won.
        const winner = await this.byKey(tenantId, input.idempotencyKey);
        if (winner) return winner;
      }
      throw error;
    }
  }

  async confirm(
    tenantId: string,
    appointmentId: string,
    now: Date = new Date(),
  ): Promise<Appointment> {
    const current = await this.get(tenantId, appointmentId);
    if (current.status === 'CONFIRMED') return current;
    if (current.status !== 'HELD')
      throw new InvalidAppointmentStateError(current.status);
    const done = await this.prisma.appointment.updateMany({
      where: {
        id: appointmentId,
        tenantId,
        status: 'HELD',
        holdExpiresAt: { gt: now },
      },
      data: { status: 'CONFIRMED', holdExpiresAt: null },
    });
    if (done.count === 0) {
      await this.prisma.appointment.updateMany({
        where: {
          id: appointmentId,
          tenantId,
          status: 'HELD',
          holdExpiresAt: { lte: now },
        },
        data: { status: 'EXPIRED' },
      });
      throw new HoldExpiredError();
    }
    return this.get(tenantId, appointmentId);
  }

  async cancel(tenantId: string, appointmentId: string): Promise<Appointment> {
    const current = await this.get(tenantId, appointmentId);
    if (current.status === 'CANCELLED') return current;
    if (current.status !== 'HELD' && current.status !== 'CONFIRMED')
      throw new InvalidAppointmentStateError(current.status);
    await this.prisma.appointment.updateMany({
      where: {
        id: appointmentId,
        tenantId,
        status: { in: ['HELD', 'CONFIRMED'] },
      },
      data: { status: 'CANCELLED', holdExpiresAt: null },
    });
    return this.get(tenantId, appointmentId);
  }

  private async get(tenantId: string, id: string): Promise<Appointment> {
    const row = await this.prisma.appointment.findFirst({
      where: { id, tenantId },
    });
    if (!row) throw new SchedulingNotFoundError('appointment');
    return row;
  }

  private byKey(
    tenantId: string,
    idempotencyKey: string,
  ): Promise<Appointment | null> {
    return this.prisma.appointment.findFirst({
      where: { tenantId, idempotencyKey },
    });
  }

  /** Loads tenant-scoped data and runs the pure slot engine. */
  private async slotsIn(
    db: Db,
    tenantId: string,
    input: FindSlotsInput & { now: Date; limit: number },
  ): Promise<Slot[]> {
    const [tenant, service] = await Promise.all([
      db.tenant.findUnique({
        where: { id: tenantId },
        select: { timezone: true },
      }),
      db.serviceType.findFirst({
        where: { id: input.serviceTypeId, tenantId, active: true },
      }),
    ]);
    if (!tenant) throw new SchedulingNotFoundError('tenant');
    if (!service) throw new SchedulingNotFoundError('service type');

    const members = await db.staffMember.findMany({
      where: {
        tenantId,
        active: true,
        ...(input.staffMemberId ? { id: input.staffMemberId } : {}),
      },
      include: { rules: true, exceptions: true },
    });
    if (input.staffMemberId && members.length === 0)
      throw new SchedulingNotFoundError('staff member');

    // Appointments reach back one day so a blocked range that started before
    // the window but still overlaps it is not missed.
    const active = await db.appointment.findMany({
      where: {
        tenantId,
        staffMemberId: { in: members.map((m) => m.id) },
        blockedUntil: { gt: new Date(input.from.getTime() - 24 * 60 * MINUTE) },
        blockedFrom: { lt: new Date(input.to.getTime() + 24 * 60 * MINUTE) },
        OR: [
          { status: 'CONFIRMED' },
          { status: 'HELD', holdExpiresAt: { gt: input.now } },
        ],
      },
      select: { staffMemberId: true, blockedFrom: true, blockedUntil: true },
    });
    const blocked: BlockedRange[] = active.map((a) => ({
      staffId: a.staffMemberId,
      from: a.blockedFrom,
      until: a.blockedUntil,
    }));

    const staff: SlotStaff[] = members.map((m) => ({
      id: m.id,
      skills: m.skills,
      timezone: m.timezone,
      rules: m.rules.map((r) => ({
        weekday: r.weekday,
        startTime: r.startTime,
        endTime: r.endTime,
        validFrom: dateOnly(r.validFrom),
        validUntil: dateOnly(r.validUntil),
      })),
      exceptions: m.exceptions.map((x) => ({
        startDate: x.startDate.toISOString().slice(0, 10),
        endDate: x.endDate.toISOString().slice(0, 10),
        startTime: x.startTime,
        endTime: x.endTime,
        unavailable: x.unavailable,
      })),
    }));

    return findSlots({
      service: {
        durationMinutes: service.durationMinutes,
        bufferBeforeMinutes: service.bufferBeforeMinutes,
        bufferAfterMinutes: service.bufferAfterMinutes,
        leadTimeMinutes: service.leadTimeMinutes,
        requiredSkills: service.requiredSkills,
      },
      staff,
      blocked,
      now: input.now,
      from: input.from,
      to: input.to,
      tenantTimezone: tenant.timezone,
      maxResults: input.limit,
    });
  }
}
