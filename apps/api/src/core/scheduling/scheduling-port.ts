/**
 * Scheduling port (ADR 046 step 2): the generic, neutral view of appointment
 * scheduling the agent core needs. The implementation lives outside core
 * (`src/scheduling/`); core never sees a table, a CRM or a vertical word.
 *
 * Contract:
 *  - slot ids and booking ids are opaque, issued by the implementation; the
 *    model only copies them from tool results and never composes a time;
 *  - every method is already scoped to one tenant and one customer;
 *  - `hold`, `holdReplacement` and `prepareCancel` change nothing the
 *    customer can rely on: the result only becomes real after the customer's
 *    confirmation, which code detects and applies (ADR 024).
 */

export type PartOfDay = 'morning' | 'afternoon' | 'evening';

export interface SchedulingServiceType {
  readonly key: string;
  readonly title: string;
}

export interface SchedulingSlot {
  readonly slotId: string;
  readonly serviceKey: string;
  readonly serviceTitle: string;
  readonly staffName: string;
  readonly startsAtIso: string;
  readonly endsAtIso: string;
}

export interface SchedulingAppointmentView {
  /** Opaque booking reference; only valid for the requesting customer. */
  readonly bookingId: string;
  readonly serviceTitle: string;
  readonly staffName: string;
  readonly startsAtIso: string;
  readonly status: 'HELD' | 'CONFIRMED';
}

export interface SchedulingHold {
  readonly appointment: SchedulingAppointmentView;
  readonly holdExpiresAtIso: string;
}

export type SchedulingFailure =
  'SLOT_TAKEN' | 'SLOT_UNAVAILABLE' | 'NOT_FOUND' | 'UNAVAILABLE';

export type SchedulingResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: SchedulingFailure };

export interface SchedulingFindQuery {
  readonly serviceKey: string;
  /** Local date `YYYY-MM-DD` in the business time zone. */
  readonly preferredDate?: string;
  readonly partOfDay?: PartOfDay;
  readonly limit: number;
}

export interface SchedulingPort {
  /** Active service types the tenant offers (non-empty when the port exists). */
  readonly serviceTypes: readonly SchedulingServiceType[];
  findSlots(
    query: SchedulingFindQuery,
  ): Promise<SchedulingResult<readonly SchedulingSlot[]>>;
  /** The customer's own confirmed, future appointments. */
  upcoming(): Promise<readonly SchedulingAppointmentView[]>;
  /** Holds the slot briefly for the customer (appointment status HELD). */
  hold(slotId: string): Promise<SchedulingResult<SchedulingHold>>;
  /** Holds a new slot to replace one of the customer's own appointments. */
  holdReplacement(
    bookingId: string,
    slotId: string,
  ): Promise<
    SchedulingResult<{
      readonly hold: SchedulingHold;
      readonly replaces: SchedulingAppointmentView;
    }>
  >;
  /** Checks that the appointment is the customer's own and still cancellable. */
  prepareCancel(
    bookingId: string,
  ): Promise<SchedulingResult<SchedulingAppointmentView>>;
}

/** What a scheduling tool asks the customer to confirm in the next message. */
export interface SchedulingChange {
  readonly operation: 'book' | 'cancel' | 'reschedule';
  /** The appointment to confirm (book, reschedule: the new held one) or cancel. */
  readonly appointmentId: string;
  /** Reschedule only: the appointment given up when the new one is confirmed. */
  readonly replacesAppointmentId?: string;
  readonly view: {
    readonly serviceTitle: string;
    readonly staffName: string;
    readonly startsAtIso: string;
    readonly previousStartsAtIso?: string;
  };
  /** When the proposal (and any hold) lapses. */
  readonly expiresAtIso: string;
}
