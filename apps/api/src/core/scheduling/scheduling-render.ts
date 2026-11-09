import { formatDateTime, type LocalePack } from '../locales/locale-pack.js';
import type { SchedulingChange } from './scheduling-port.js';

/**
 * Code-rendered scheduling texts (D4, D5). Every time and staff name comes
 * from stored appointment data and is formatted here; the model never writes
 * a proposal, a confirmation or an outcome.
 */

export type SchedulingOperation = SchedulingChange['operation'];
export type SchedulingView = SchedulingChange['view'];

/** A change the customer has been asked to confirm (kept with the proposal). */
export interface PendingScheduling {
  readonly operation: SchedulingOperation;
  readonly view: SchedulingView;
}

/** Stored as the turn's asked slot so the next turn stays in scheduling mode. */
export const SCHEDULING_MARK = 'scheduling:conversation';

function fill(
  template: string,
  view: SchedulingView,
  locale: LocalePack,
  timeZone: string,
): string {
  return template
    .replaceAll('{service}', view.serviceTitle)
    .replaceAll('{staff}', view.staffName)
    .replaceAll('{when}', formatDateTime(locale, view.startsAtIso, timeZone))
    .replaceAll(
      '{previous}',
      view.previousStartsAtIso
        ? formatDateTime(locale, view.previousStartsAtIso, timeZone)
        : '',
    );
}

/** The question the customer answers with the locale's confirm/decline phrase. */
export function renderSchedulingProposal(
  pending: PendingScheduling,
  locale: LocalePack,
  timeZone: string,
): string {
  const t = locale.templates.scheduling;
  const body =
    pending.operation === 'book'
      ? t.bookProposal
      : pending.operation === 'cancel'
        ? t.cancelProposal
        : t.rescheduleProposal;
  return [
    fill(body, pending.view, locale, timeZone),
    locale.templates.actions.confirmPrompt
      .replace('{yes}', locale.actionConfirmPhrases[0] ?? '')
      .replace('{no}', locale.actionDeclinePhrases[0] ?? ''),
  ].join('\n');
}

/** The reply to an exact "yes" (replaced at commit if the change no longer applies). */
export function renderSchedulingDone(
  pending: PendingScheduling,
  locale: LocalePack,
  timeZone: string,
): string {
  const t = locale.templates.scheduling;
  const body =
    pending.operation === 'book'
      ? t.booked
      : pending.operation === 'cancel'
        ? t.cancelled
        : t.rescheduled;
  return fill(body, pending.view, locale, timeZone);
}

/** The reply to an exact "no". */
export function renderSchedulingDeclined(
  pending: PendingScheduling,
  locale: LocalePack,
): string {
  return pending.operation === 'cancel'
    ? locale.templates.scheduling.kept
    : locale.templates.scheduling.released;
}

/** The proposal payload that binds the digest and is stored with the proposal. */
export function schedulingPayload(
  change: Pick<SchedulingChange, 'appointmentId' | 'replacesAppointmentId'>,
): Readonly<Record<string, string>> {
  return {
    appointmentId: change.appointmentId,
    ...(change.replacesAppointmentId
      ? { replacesAppointmentId: change.replacesAppointmentId }
      : {}),
  };
}
