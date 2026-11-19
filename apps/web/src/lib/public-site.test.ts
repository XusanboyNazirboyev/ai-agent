import { describe, expect, it } from 'vitest';
import {
  leadLimitNotice,
  planLimitLines,
  safeContactUrl,
  signupHref,
} from './public-site';

describe('public site helpers', () => {
  it('links plans to signup with the code', () => {
    expect(signupHref('basic')).toBe('/signup?plan=basic');
    expect(signupHref('a b')).toBe('/signup?plan=a%20b');
    expect(signupHref()).toBe('/signup');
  });
  it('accepts only https contact links', () => {
    expect(safeContactUrl('https://t.me/x', undefined)).toBe('https://t.me/x');
    expect(safeContactUrl(null, 'https://t.me/y')).toBe('https://t.me/y');
    expect(safeContactUrl('javascript:alert(1)', undefined)).toBeNull();
    expect(safeContactUrl('http://x.test', '')).toBeNull();
    expect(safeContactUrl(null, undefined)).toBeNull();
  });
  it('lists limits in order', () => {
    expect(
      planLimitLines({ maxOperators: 3, monthlyNewLeads: 500 }).map(
        (l) => l.key,
      ),
    ).toEqual(['site.plans.leads', 'site.plans.operators']);
    expect(planLimitLines({})).toEqual([]);
  });
  it('warns from 80 percent', () => {
    expect(leadLimitNotice(null)).toBeNull();
    expect(
      leadLimitNotice({ newLeadsThisMonth: 79, monthlyNewLeads: 100 }),
    ).toBeNull();
    expect(
      leadLimitNotice({ newLeadsThisMonth: 80, monthlyNewLeads: 100 }),
    ).toBe('near');
    expect(
      leadLimitNotice({ newLeadsThisMonth: 100, monthlyNewLeads: 100 }),
    ).toBe('reached');
  });
});
