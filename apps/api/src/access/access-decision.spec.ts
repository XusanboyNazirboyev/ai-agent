import { describe, expect, it } from 'vitest';
import {
  billingRequired,
  decideAccess,
  type AccessInput,
} from './access-decision.js';

const NOW = new Date('2026-11-15T12:00:00Z');
const day = (offset: number): Date =>
  new Date(NOW.getTime() + offset * 24 * 60 * 60 * 1000);

function input(overrides: Partial<AccessInput> = {}): AccessInput {
  return {
    tenantStatus: 'ACTIVE',
    billingRequired: false,
    latest: null,
    ...overrides,
  };
}

describe('tenant access decision (ADR 047 §3)', () => {
  it('suspension and archive win over any subscription', () => {
    const latest = {
      status: 'ACTIVE' as const,
      currentPeriodEnd: day(10),
      graceUntil: null,
    };
    expect(
      decideAccess(input({ tenantStatus: 'SUSPENDED', latest }), NOW).state,
    ).toBe('SUSPENDED');
    expect(
      decideAccess(input({ tenantStatus: 'ARCHIVED', latest }), NOW).state,
    ).toBe('ARCHIVED');
  });

  it('a tenant without any subscription row works unless billing is required', () => {
    expect(decideAccess(input(), NOW).state).toBe('ok');
    expect(decideAccess(input({ billingRequired: true }), NOW).state).toBe(
      'SUBSCRIPTION_EXPIRED',
    );
  });

  it('TRIAL and ACTIVE work, also between period end and the scan', () => {
    for (const status of ['TRIAL', 'ACTIVE'] as const) {
      const access = decideAccess(
        input({
          latest: { status, currentPeriodEnd: day(-1), graceUntil: null },
        }),
        NOW,
      );
      expect(access.state).toBe('ok');
      expect(access.periodEnd).toEqual(day(-1));
    }
  });

  it('PAST_DUE works inside the grace period and expires after it', () => {
    const inGrace = decideAccess(
      input({
        latest: {
          status: 'PAST_DUE',
          currentPeriodEnd: day(-1),
          graceUntil: day(2),
        },
      }),
      NOW,
    );
    expect(inGrace).toMatchObject({ state: 'ok', graceUntil: day(2) });
    const past = decideAccess(
      input({
        latest: {
          status: 'PAST_DUE',
          currentPeriodEnd: day(-4),
          graceUntil: day(-1),
        },
      }),
      NOW,
    );
    expect(past.state).toBe('SUBSCRIPTION_EXPIRED');
  });

  it('EXPIRED and CANCELED rows mean expired even without the billing flag', () => {
    for (const status of ['EXPIRED', 'CANCELED'] as const)
      expect(
        decideAccess(
          input({
            latest: { status, currentPeriodEnd: day(5), graceUntil: null },
          }),
          NOW,
        ).state,
      ).toBe('SUBSCRIPTION_EXPIRED');
  });

  it('reads config.billing.required strictly', () => {
    expect(billingRequired({ billing: { required: true } })).toBe(true);
    expect(billingRequired({ billing: { required: 'true' } })).toBe(false);
    expect(billingRequired({ billing: true })).toBe(false);
    expect(billingRequired(null)).toBe(false);
    expect(billingRequired([])).toBe(false);
  });
});
