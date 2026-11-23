import { describe, expect, it } from 'vitest';
import {
  planFromSearch,
  pollAction,
  signupExpired,
  signupFormProblem,
} from './signup';

const ok = {
  businessName: 'Shop',
  businessType: 'travel' as const,
  name: 'Ali',
  email: 'a@b.co',
  password: '0123456789',
};

describe('signup helpers', () => {
  it('reads a plan code only when it looks like one', () => {
    expect(planFromSearch('?plan=basic')).toBe('basic');
    expect(planFromSearch('?plan=a b')).toBeUndefined();
    expect(planFromSearch('')).toBeUndefined();
  });
  it('names the first problem of the form', () => {
    expect(signupFormProblem(ok)).toBeUndefined();
    expect(signupFormProblem({ ...ok, businessName: 'S' })).toBe(
      'signup.form.businessRequired',
    );
    expect(signupFormProblem({ ...ok, businessType: '' })).toBe(
      'signup.form.typeRequired',
    );
    // ADR 087: any other business gets the general pack.
    expect(signupFormProblem({ ...ok, businessType: 'general' })).toBe(
      undefined,
    );
    expect(signupFormProblem({ ...ok, businessType: 'education' })).toBe(
      undefined,
    );
    expect(signupFormProblem({ ...ok, name: ' ' })).toBe(
      'signup.form.nameRequired',
    );
    expect(signupFormProblem({ ...ok, email: 'nope' })).toBe(
      'signup.form.emailInvalid',
    );
    expect(signupFormProblem({ ...ok, password: 'short' })).toBe(
      'signup.form.passwordShort',
    );
  });
  it('maps status answers to actions', () => {
    expect(pollAction({ status: 'PENDING' })).toBe('wait');
    expect(pollAction({ status: 'CONFIRMED', signedIn: true })).toBe('welcome');
    expect(pollAction({ status: 'CONFIRMED', signedIn: false })).toBe('signin');
    expect(pollAction({ status: 'EXPIRED' })).toBe('expired');
    expect(pollAction({ status: 'REFUSED', reason: 'TRIAL_USED' })).toBe(
      'refused',
    );
  });
  it('knows when the window is over', () => {
    expect(
      signupExpired('2026-01-01T00:00:00Z', Date.parse('2026-01-02')),
    ).toBe(true);
    expect(
      signupExpired('2026-01-02T00:00:00Z', Date.parse('2026-01-01')),
    ).toBe(false);
  });
});
