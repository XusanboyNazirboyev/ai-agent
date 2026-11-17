import { describe, expect, it } from 'vitest';
import { monthlyLlmBudgetNano, planLimitsOf } from './plan-limits.js';

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
