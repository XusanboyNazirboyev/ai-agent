/** Self-serve signup helpers (ADR 080). Pure: the page and its tests share them. */

export const SIGNUP_POLL_MS = 2000;
/** Same lengths as the API (zod): invites' password policy. */
export const SIGNUP_MIN_PASSWORD = 10;

/** Plan code used when neither `?plan=` nor the public plans give one. */
export const DEFAULT_PLAN_CODE = 'basic';

/**
 * Business types offered at signup (owner 2026-11-23): each is the API's
 * Domain Pack key; `general` serves every other business (ADR 087).
 */
export const BUSINESS_TYPES = ['travel', 'education', 'general'] as const;
export type BusinessType = (typeof BUSINESS_TYPES)[number] | '';

export interface SignupForm {
  businessName: string;
  businessType: BusinessType;
  name: string;
  email: string;
  password: string;
}

export interface SignupCreated {
  id: string;
  telegramUrl: string;
  expiresAt: string;
}

export type SignupStatus =
  | { status: 'PENDING' }
  | { status: 'EXPIRED' }
  | { status: 'REFUSED'; reason?: string | null }
  | { status: 'CONFIRMED'; signedIn?: boolean };

/** The plan code from `?plan=`, only when it looks like a code. */
export function planFromSearch(search: string): string | undefined {
  const value = new URLSearchParams(search).get('plan')?.trim();
  return value && /^[A-Za-z0-9_-]{1,60}$/u.test(value) ? value : undefined;
}

/** The first problem of the form as an i18n key, or undefined when it can be sent. */
export function signupFormProblem(form: SignupForm): string | undefined {
  if (form.businessName.trim().length < 2)
    return 'signup.form.businessRequired';
  if (!form.businessType) return 'signup.form.typeRequired';
  if (!form.name.trim()) return 'signup.form.nameRequired';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(form.email.trim()))
    return 'signup.form.emailInvalid';
  if (form.password.length < SIGNUP_MIN_PASSWORD)
    return 'signup.form.passwordShort';
  return undefined;
}

export type PollAction = 'wait' | 'welcome' | 'expired' | 'refused' | 'signin';

/** What the confirm step does with one status answer. */
export function pollAction(status: SignupStatus): PollAction {
  switch (status.status) {
    case 'CONFIRMED':
      return status.signedIn ? 'welcome' : 'signin';
    case 'EXPIRED':
      return 'expired';
    case 'REFUSED':
      return 'refused';
    default:
      return 'wait';
  }
}

/** True once the 30-minute window is over (the server also says EXPIRED). */
export function signupExpired(expiresAt: string, now: number): boolean {
  return Date.parse(expiresAt) <= now;
}
