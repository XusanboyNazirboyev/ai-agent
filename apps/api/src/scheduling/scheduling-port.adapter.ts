import { createHash, randomUUID } from 'node:crypto';
import type {
  PartOfDay,
  SchedulingAppointmentView,
  SchedulingFailure,
  SchedulingFindQuery,
  SchedulingHold,
  SchedulingPort,
  SchedulingResult,
  SchedulingServiceType,
  SchedulingSlot,
} from '../core/scheduling/scheduling-port.js';
import type { PrismaService } from '../persistence/prisma.service.js';
import type { AppointmentService } from './appointment.service.js';
import {
  SchedulingNotFoundError,
  SlotTakenError,
  SlotUnavailableError,
} from './scheduling.errors.js';
import { zonedToUtc } from './slot-engine.js';

/**
 * The agent's view of scheduling (ADR 046 step 2), scoped to one tenant, one
 * conversation and the conversation's contact. It adapts the appointment
 * service to the neutral `SchedulingPort` of the core.
 *
 * Slot ids are issued here and are opaque to the model:
 * `<serviceTypeId>.<local date>.<hash>`, where the hash covers tenant,
 * conversation, service, staff member and start time. A slot is resolved only
 * by re-running the slot engine for that day and matching the hash, so an id
 * the engine did not issue (or one from another conversation) is refused.
 */

const SLOT_ID = /^([0-9a-f-]{36})\.(\d{8})\.([0-9a-f]{16})$/u;
const HOLD_WINDOW_DAYS = 14;
const DAY_SLOTS_LIMIT = 500;
const DAY_MS = 86_400_000;

type Db = Pick<PrismaService, 'appointment' | 'staffMember'>;

export interface ServiceRow {
  readonly id: string;
  readonly key: string;
  readonly title: string;
}

export interface PortScope {
  readonly tenantId: string;
  readonly conversationId: string;
  readonly contactId: string;
  readonly turnKey: string;
  readonly timeZone: string;
  readonly now: () => Date;
}

function slotHash(
  scope: Pick<PortScope, 'tenantId' | 'conversationId'>,
  serviceTypeId: string,
  staffId: string,
  startsAt: Date,
): string {
  return createHash('sha256')
    .update(
      [
        scope.tenantId,
        scope.conversationId,
        serviceTypeId,
        staffId,
        startsAt.toISOString(),
      ].join('|'),
    )
    .digest('hex')
    .slice(0, 16);
}

function localDate(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);
}

function localHour(instant: Date, timeZone: string): number {
  const hour = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    hourCycle: 'h23',
  }).format(instant);
  return Number.parseInt(hour, 10);
}

function partOf(hour: number): PartOfDay {
  return hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening';
}

function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

function fail<T>(code: SchedulingFailure): SchedulingResult<T> {
  return { ok: false, code };
}

export class AppointmentSchedulingPort implements SchedulingPort {
  readonly serviceTypes: readonly SchedulingServiceType[];

  constructor(
    private readonly prisma: PrismaService,
    private readonly appointments: AppointmentService,
    private readonly scope: PortScope,
    private readonly services: readonly ServiceRow[],
  ) {
    this.serviceTypes = services.map(({ key, title }) => ({ key, title }));
  }

  private get db(): Db {
    return this.prisma;
  }

  private async staffNames(
    ids: readonly string[],
  ): Promise<Map<string, string>> {
    const rows = await this.db.staffMember.findMany({
      where: { tenantId: this.scope.tenantId, id: { in: [...new Set(ids)] } },
      select: { id: true, displayName: true },
    });
    return new Map(rows.map((row) => [row.id, row.displayName]));
  }

  /** Engine slots of one service in a window, with display data. */
  private async engineSlots(
    service: ServiceRow,
    from: Date,
    to: Date,
    limit: number,
  ): Promise<
    {
      slot: Awaited<ReturnType<AppointmentService['findSlots']>>[number];
      id: string;
    }[]
  > {
    const found = await this.appointments.findSlots(this.scope.tenantId, {
      serviceTypeId: service.id,
      from,
      to,
      limit,
      now: this.scope.now(),
    });
    return found.map((slot) => ({
      slot,
      id: `${service.id}.${localDate(slot.startsAt, this.scope.timeZone).replaceAll('-', '')}.${slotHash(this.scope, service.id, slot.staffId, slot.startsAt)}`,
    }));
  }

  async findSlots(
    query: SchedulingFindQuery,
  ): Promise<SchedulingResult<readonly SchedulingSlot[]>> {
    const service = this.services.find(
      (entry) => entry.key === query.serviceKey,
    );
    if (!service) return fail('NOT_FOUND');
    const now = this.scope.now();
    const tz = this.scope.timeZone;
    const from = query.preferredDate
      ? new Date(zonedToUtc(query.preferredDate, 0, tz))
      : now;
    const to = query.preferredDate
      ? new Date(zonedToUtc(addDays(query.preferredDate, 1), 0, tz))
      : new Date(now.getTime() + HOLD_WINDOW_DAYS * DAY_MS);
    try {
      const found = await this.engineSlots(service, from, to, DAY_SLOTS_LIMIT);
      const chosen = found
        .filter(
          ({ slot }) =>
            !query.partOfDay ||
            partOf(localHour(slot.startsAt, tz)) === query.partOfDay,
        )
        .slice(0, query.limit);
      const names = await this.staffNames(
        chosen.map(({ slot }) => slot.staffId),
      );
      return {
        ok: true,
        value: chosen.map(({ slot, id }) => ({
          slotId: id,
          serviceKey: service.key,
          serviceTitle: service.title,
          staffName: names.get(slot.staffId) ?? '',
          startsAtIso: slot.startsAt.toISOString(),
          endsAtIso: slot.endsAt.toISOString(),
        })),
      };
    } catch (error: unknown) {
      if (error instanceof SchedulingNotFoundError) return fail('NOT_FOUND');
      throw error;
    }
  }

  private async view(
    row: {
      id: string;
      startsAt: Date;
      status: string;
      staffMemberId: string;
      serviceTypeId: string;
    },
    names?: Map<string, string>,
  ): Promise<SchedulingAppointmentView> {
    const map = names ?? (await this.staffNames([row.staffMemberId]));
    return {
      bookingId: row.id,
      serviceTitle:
        this.services.find((service) => service.id === row.serviceTypeId)
          ?.title ?? '',
      staffName: map.get(row.staffMemberId) ?? '',
      startsAtIso: row.startsAt.toISOString(),
      status: row.status === 'HELD' ? 'HELD' : 'CONFIRMED',
    };
  }

  async upcoming(): Promise<readonly SchedulingAppointmentView[]> {
    const rows = await this.db.appointment.findMany({
      where: {
        tenantId: this.scope.tenantId,
        contactId: this.scope.contactId,
        status: 'CONFIRMED',
        startsAt: { gt: this.scope.now() },
      },
      orderBy: { startsAt: 'asc' },
      take: 10,
    });
    const names = await this.staffNames(rows.map((row) => row.staffMemberId));
    return Promise.all(rows.map((row) => this.view(row, names)));
  }

  /** The customer's own confirmed future appointment, or undefined. */
  private ownConfirmed(bookingId: string) {
    return this.db.appointment.findFirst({
      where: {
        id: bookingId,
        tenantId: this.scope.tenantId,
        contactId: this.scope.contactId,
        status: 'CONFIRMED',
        startsAt: { gt: this.scope.now() },
      },
    });
  }

  async prepareCancel(
    bookingId: string,
  ): Promise<SchedulingResult<SchedulingAppointmentView>> {
    const row = await this.ownConfirmed(bookingId);
    if (!row) return fail('NOT_FOUND');
    return { ok: true, value: await this.view(row) };
  }

  /** Resolves a slot id issued earlier in this conversation. */
  private async resolve(slotId: string): Promise<
    SchedulingResult<{
      service: ServiceRow;
      slot: Awaited<ReturnType<AppointmentService['findSlots']>>[number];
    }>
  > {
    const match = SLOT_ID.exec(slotId);
    if (!match) return fail('SLOT_UNAVAILABLE');
    const service = this.services.find((entry) => entry.id === match[1]);
    if (!service) return fail('SLOT_UNAVAILABLE');
    const day = `${match[2].slice(0, 4)}-${match[2].slice(4, 6)}-${match[2].slice(6, 8)}`;
    const tz = this.scope.timeZone;
    try {
      const found = await this.engineSlots(
        service,
        new Date(zonedToUtc(day, 0, tz)),
        new Date(zonedToUtc(addDays(day, 1), 0, tz)),
        DAY_SLOTS_LIMIT,
      );
      const hit = found.find((entry) => entry.id === slotId);
      return hit
        ? { ok: true, value: { service, slot: hit.slot } }
        : fail('SLOT_UNAVAILABLE');
    } catch (error: unknown) {
      if (error instanceof SchedulingNotFoundError) return fail('NOT_FOUND');
      throw error;
    }
  }

  /** Holds a resolved slot; own earlier holds in this conversation are released first. */
  private async holdResolved(
    service: ServiceRow,
    slot: { staffId: string; startsAt: Date },
    slotId: string,
  ): Promise<SchedulingResult<SchedulingHold>> {
    const { tenantId, contactId, conversationId } = this.scope;
    const now = this.scope.now();
    const baseKey = `chat:${this.scope.turnKey}:${slotId.slice(-16)}`;
    // A retried attempt of the same turn finds its own hold again.
    const again = await this.db.appointment.findFirst({
      where: { tenantId, idempotencyKey: baseKey },
    });
    let key = baseKey;
    if (
      again &&
      again.contactId === contactId &&
      again.status === 'HELD' &&
      again.holdExpiresAt &&
      again.holdExpiresAt > now
    ) {
      return {
        ok: true,
        value: {
          appointment: await this.view(again),
          holdExpiresAtIso: again.holdExpiresAt.toISOString(),
        },
      };
    }
    if (again) key = `${baseKey}:${randomUUID().slice(0, 8)}`;
    await this.db.appointment.updateMany({
      where: { tenantId, contactId, conversationId, status: 'HELD' },
      data: { status: 'CANCELLED', holdExpiresAt: null },
    });
    try {
      const row = await this.appointments.hold(tenantId, {
        serviceTypeId: service.id,
        staffMemberId: slot.staffId,
        startsAt: slot.startsAt,
        contactId,
        conversationId,
        idempotencyKey: key,
        now,
      });
      return {
        ok: true,
        value: {
          appointment: await this.view(row),
          holdExpiresAtIso: (row.holdExpiresAt ?? now).toISOString(),
        },
      };
    } catch (error: unknown) {
      if (error instanceof SlotTakenError) return fail('SLOT_TAKEN');
      if (error instanceof SlotUnavailableError)
        return fail('SLOT_UNAVAILABLE');
      if (error instanceof SchedulingNotFoundError) return fail('NOT_FOUND');
      throw error;
    }
  }

  async hold(slotId: string): Promise<SchedulingResult<SchedulingHold>> {
    const resolved = await this.resolve(slotId);
    if (!resolved.ok) return resolved;
    return this.holdResolved(
      resolved.value.service,
      resolved.value.slot,
      slotId,
    );
  }

  async holdReplacement(
    bookingId: string,
    slotId: string,
  ): Promise<
    SchedulingResult<{
      hold: SchedulingHold;
      replaces: SchedulingAppointmentView;
    }>
  > {
    const old = await this.ownConfirmed(bookingId);
    if (!old) return fail('NOT_FOUND');
    const resolved = await this.resolve(slotId);
    if (!resolved.ok) return resolved;
    // A move keeps the same service; another service is a new booking.
    if (resolved.value.service.id !== old.serviceTypeId)
      return fail('SLOT_UNAVAILABLE');
    const held = await this.holdResolved(
      resolved.value.service,
      resolved.value.slot,
      slotId,
    );
    if (!held.ok) return held;
    return {
      ok: true,
      value: { hold: held.value, replaces: await this.view(old) },
    };
  }
}
