import { describe, expect, it } from 'vitest';
import {
  renderSchedulingDeclined,
  renderSchedulingDone,
  renderSchedulingProposal,
  schedulingPayload,
  SCHEDULING_MARK,
  type PendingScheduling,
} from './scheduling-render.js';

const locale = {
  intlLocale: 'en-US',
  templates: {
    actions: { confirmPrompt: 'Reply {yes} or {no}.' },
    scheduling: {
      bookProposal: 'Book {service} with {staff} at {when}?',
      cancelProposal: 'Cancel {service} with {staff} at {when}?',
      rescheduleProposal:
        'Move {service} from {previous} to {when} with {staff}?',
      booked: 'Booked {service} with {staff} at {when}.',
      cancelled: 'Cancelled {service} with {staff} at {when}.',
      rescheduled: 'Rescheduled {service} to {when} with {staff}.',
      kept: 'Kept as is.',
      released: 'Released the time.',
      holdExpired: 'Hold expired.',
      notAvailableAnymore: 'Not available.',
    },
  },
  actionConfirmPhrases: ['yes'],
  actionDeclinePhrases: ['no'],
} as unknown as Parameters<typeof renderSchedulingProposal>[1];

const view = {
  serviceTitle: 'Haircut',
  staffName: 'Alex',
  startsAtIso: '2026-11-12T10:00:00.000Z',
  previousStartsAtIso: '2026-11-11T09:00:00.000Z',
};

describe('scheduling-render', () => {
  it('renders proposals for book/cancel/reschedule with filled values and confirm prompt', () => {
    const book: PendingScheduling = { operation: 'book', view };
    const cancel: PendingScheduling = { operation: 'cancel', view };
    const move: PendingScheduling = { operation: 'reschedule', view };
    expect(renderSchedulingProposal(book, locale, 'UTC')).toContain('Haircut');
    expect(renderSchedulingProposal(book, locale, 'UTC')).toContain('Alex');
    expect(renderSchedulingProposal(book, locale, 'UTC')).toContain(
      'Reply yes or no.',
    );
    expect(renderSchedulingProposal(cancel, locale, 'UTC')).toContain(
      'Cancel Haircut',
    );
    const moved = renderSchedulingProposal(move, locale, 'UTC');
    expect(moved).toContain('Move Haircut');
    expect(moved).toContain('Haircut');
  });

  it('renders done messages per operation', () => {
    expect(
      renderSchedulingDone({ operation: 'book', view }, locale, 'UTC'),
    ).toContain('Booked Haircut');
    expect(
      renderSchedulingDone({ operation: 'cancel', view }, locale, 'UTC'),
    ).toContain('Cancelled Haircut');
    expect(
      renderSchedulingDone({ operation: 'reschedule', view }, locale, 'UTC'),
    ).toContain('Rescheduled Haircut');
  });

  it('renders declined replies (cancel keeps, others released)', () => {
    expect(
      renderSchedulingDeclined({ operation: 'cancel', view }, locale),
    ).toBe('Kept as is.');
    expect(renderSchedulingDeclined({ operation: 'book', view }, locale)).toBe(
      'Released the time.',
    );
    expect(
      renderSchedulingDeclined({ operation: 'reschedule', view }, locale),
    ).toBe('Released the time.');
  });

  it('builds payload and exposes scheduling mark', () => {
    expect(SCHEDULING_MARK).toBe('scheduling:conversation');
    expect(
      schedulingPayload({ appointmentId: 'a1', replacesAppointmentId: 'a0' }),
    ).toEqual({ appointmentId: 'a1', replacesAppointmentId: 'a0' });
    expect(schedulingPayload({ appointmentId: 'a1' })).toEqual({
      appointmentId: 'a1',
    });
  });
});
