import { describe, expect, it } from 'vitest';
import { MockConnector } from '../connectors/mock/mock-connector.js';
import { FactStore } from '../core/agent/facts.js';
import { AgentTools } from '../core/agent/tools.js';
import { TurnBudget } from '../core/llm/budget.js';
import type {
  SchedulingAppointmentView,
  SchedulingPort,
} from '../core/scheduling/scheduling-port.js';
import { TEST_LIMITS } from '../agent/testing/agent-harness.js';
import { SCHEDULING_TEST_PACK } from './testing/scheduling-test-pack.js';

const NOW = new Date('2026-11-10T08:00:00Z');
const OWN: SchedulingAppointmentView = {
  bookingId: 'own-1',
  serviceTitle: 'Visit',
  staffName: 'Aziza',
  startsAtIso: '2026-11-12T05:00:00.000Z',
  status: 'CONFIRMED',
};
const SLOT = 'slot-aaaaaaaa';

function port(): SchedulingPort {
  const held = {
    appointment: { ...OWN, bookingId: 'held-1', status: 'HELD' as const },
    holdExpiresAtIso: '2026-11-10T08:10:00.000Z',
  };
  return {
    serviceTypes: [{ key: 'visit', title: 'Visit' }],
    findSlots: async () => ({
      ok: true,
      value: [
        {
          slotId: SLOT,
          serviceKey: 'visit',
          serviceTitle: 'Visit',
          staffName: 'Aziza',
          startsAtIso: '2026-11-11T05:00:00.000Z',
          endsAtIso: '2026-11-11T06:00:00.000Z',
        },
      ],
    }),
    upcoming: async () => [OWN],
    hold: async (id) =>
      id === SLOT
        ? { ok: true, value: held }
        : { ok: false, code: 'SLOT_UNAVAILABLE' },
    holdReplacement: async (b, id) =>
      b === 'own-1' && id === SLOT
        ? { ok: true, value: { hold: held, replaces: OWN } }
        : { ok: false, code: 'NOT_FOUND' },
    prepareCancel: async (b) =>
      b === 'own-1'
        ? { ok: true, value: OWN }
        : { ok: false, code: 'NOT_FOUND' },
  };
}

function tools(withPort = true): { t: AgentTools; facts: FactStore } {
  const facts = new FactStore();
  const t = new AgentTools({
    connector: new MockConnector(
      { tenantId: 't', connectorKey: 'mock' },
      { sourceSystem: 'mock-education', items: [] },
    ),
    pack: SCHEDULING_TEST_PACK,
    facts,
    budget: new TurnBudget(TEST_LIMITS, {
      conversationSpentNano: 0,
      tenantMonthSpentNano: 0,
    }),
    timeoutMs: 500,
    now: () => NOW,
    scope: { tenantId: 't', conversationId: 'c' },
    ...(withPort ? { scheduling: port() } : {}),
  });
  return { t, facts };
}

describe('scheduling tools', () => {
  it('are not offered without a scheduling port', () => {
    expect(tools(false).t.available()).not.toContain('find_slots');
    expect(tools().t.available()).toEqual(
      expect.arrayContaining(['find_slots', 'book_slot', 'cancel_booking']),
    );
  });

  it('find_slots validates input and renders time and staff as facts', async () => {
    const { t, facts } = tools();
    expect((await t.run('find_slots', { serviceKey: 'x' })).ok).toBe(false);
    expect(
      (
        await t.run('find_slots', {
          serviceKey: 'visit',
          preferredDate: 'tomorrow',
        })
      ).ok,
    ).toBe(false);
    const found = await t.run('find_slots', { serviceKey: 'visit' });
    expect(found.ok).toBe(true);
    const kinds = facts.list().map((f) => f.value.kind);
    expect(kinds).toEqual(['datetime', 'title']);
    for (const fact of facts.list()) {
      expect(fact.provenance.sourceSystem).toBe('agentcore-scheduling');
      expect(fact.provenance.offerId).toBe(SLOT);
    }
  });

  it('book_slot rejects an unknown slot id and prepares a change for a known one', async () => {
    const { t } = tools();
    const bad = await t.run('book_slot', { slotId: 'invented-slot-1' });
    expect(bad).toMatchObject({ ok: false, code: 'UNKNOWN_REFERENCE' });
    expect(t.schedulingChange).toBeUndefined();
    const good = await t.run('book_slot', { slotId: SLOT });
    expect(good.ok).toBe(true);
    expect(t.schedulingChange).toMatchObject({
      operation: 'book',
      appointmentId: 'held-1',
    });
    // only one change per turn
    expect(await t.run('book_slot', { slotId: SLOT })).toMatchObject({
      ok: false,
      code: 'DUPLICATE_CALL',
    });
  });

  it("cancel and reschedule refuse bookings that are not the customer's own", async () => {
    const { t } = tools();
    expect(
      await t.run('cancel_booking', { bookingId: 'other-9' }),
    ).toMatchObject({
      ok: false,
      code: 'UNKNOWN_REFERENCE',
    });
    expect(
      await t.run('reschedule_booking', { bookingId: 'other-9', slotId: SLOT }),
    ).toMatchObject({ ok: false, code: 'UNKNOWN_REFERENCE' });
    await t.schedulingContext(); // lists own-1 as known
    const r = await t.run('reschedule_booking', {
      bookingId: 'own-1',
      slotId: SLOT,
    });
    expect(r.ok).toBe(true);
    expect(t.schedulingChange).toMatchObject({
      operation: 'reschedule',
      replacesAppointmentId: 'own-1',
    });
  });

  it('cancel_booking prepares a cancellation of a listed booking', async () => {
    const { t } = tools();
    await t.schedulingContext();
    expect((await t.run('cancel_booking', { bookingId: 'own-1' })).ok).toBe(
      true,
    );
    expect(t.schedulingChange?.operation).toBe('cancel');
  });
});
