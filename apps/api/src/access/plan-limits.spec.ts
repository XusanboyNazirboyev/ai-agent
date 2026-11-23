import { describe, expect, it } from 'vitest';
import {
  callAnalysisMinutesOf,
  effectiveChannelAccountLimit,
  monthlyLlmBudgetNano,
  planLimitsOf,
} from './plan-limits.js';

describe('planLimitsOf', () => {
  it('reads the three limits and drops anything malformed', () => {
    expect(
      planLimitsOf({
        maxOperators: 3,
        maxChannelAccounts: 0,
        monthlyLlmBudgetUsd: 12.5,
        other: 'kept out',
      }),
    ).toEqual({
      maxOperators: 3,
      maxChannelAccounts: 0,
      monthlyLlmBudgetUsd: 12.5,
    });
    expect(
      planLimitsOf({
        maxOperators: 1.5,
        maxChannelAccounts: -1,
        monthlyLlmBudgetUsd: '5',
      }),
    ).toEqual({});
    expect(planLimitsOf(null)).toEqual({});
    expect(planLimitsOf([1])).toEqual({});
    expect(planLimitsOf({ monthlyLlmBudgetUsd: Number.NaN })).toEqual({});
  });

  it('reads call analysis minutes; a plan without them has none (ADR 085)', () => {
    expect(
      callAnalysisMinutesOf(planLimitsOf({ callAnalysisMinutes: 300 })),
    ).toBe(300);
    expect(callAnalysisMinutesOf(planLimitsOf({}))).toBe(0);
    expect(
      callAnalysisMinutesOf(planLimitsOf({ callAnalysisMinutes: -5 })),
    ).toBe(0);
    expect(
      callAnalysisMinutesOf(planLimitsOf({ callAnalysisMinutes: 2.5 })),
    ).toBe(0);
  });
});

describe('effectiveChannelAccountLimit', () => {
  it('includes one channel until a paid plan explicitly grants more', () => {
    expect(effectiveChannelAccountLimit(undefined, {})).toBe(1);
    expect(
      effectiveChannelAccountLimit('TRIAL', { maxChannelAccounts: 5 }),
    ).toBe(1);
    expect(
      effectiveChannelAccountLimit('ACTIVE', { maxChannelAccounts: 3 }),
    ).toBe(3);
    expect(
      effectiveChannelAccountLimit('PAST_DUE', { maxChannelAccounts: 2 }),
    ).toBe(2);
    expect(
      effectiveChannelAccountLimit('CANCELLED', { maxChannelAccounts: 9 }),
    ).toBe(1);
    expect(
      effectiveChannelAccountLimit('ACTIVE', { maxChannelAccounts: 0 }),
    ).toBe(1);
    expect(effectiveChannelAccountLimit('ACTIVE', {})).toBe(1);
  });
});

describe('monthlyLlmBudgetNano', () => {
  it("uses the plan's budget over the server default, 0 included", () => {
    expect(monthlyLlmBudgetNano({ monthlyLlmBudgetUsd: 2.5 }, '10')).toBe(
      2_500_000_000,
    );
    expect(monthlyLlmBudgetNano({ monthlyLlmBudgetUsd: 0 }, '10')).toBe(0);
  });

  it('falls back to the server default, and to no cap without one', () => {
    expect(monthlyLlmBudgetNano({}, '0.75')).toBe(750_000_000);
    expect(
      monthlyLlmBudgetNano({ maxOperators: 2 }, undefined),
    ).toBeUndefined();
  });
});
