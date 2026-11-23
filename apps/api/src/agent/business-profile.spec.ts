import { describe, expect, it } from 'vitest';
import { TRAVEL_PACK } from '../packs/travel/travel.pack.js';
import { UZ_LATN } from '../locales/locale-packs.js';
import { displayPolicyFor } from '../core/agent/display-gate.js';
import { FactStore, type BusinessProfile } from '../core/agent/facts.js';
import { checkDraft } from '../core/agent/guardrails.js';
import {
  businessProfileRule,
  responseSystemPrompt,
} from '../core/agent/prompts.js';
import { businessProfileOf } from './business-profile.js';

const now = new Date('2026-11-23T08:00:00Z');
const scope = { tenantId: 't1', conversationId: 'c1' };
const profile: BusinessProfile = {
  name: 'Sayohat Tour',
  address: 'Toshkent, Amir Temur ko‘chasi',
  phone: '+998 90 123 45 67',
};

function check(
  draft: string,
  given?: BusinessProfile,
): ReturnType<typeof checkDraft> {
  const facts = new FactStore();
  facts.addProfileIfReferenced(draft, given, scope, now);
  return checkDraft(draft, {
    facts,
    locale: UZ_LATN,
    customerTexts: [],
    timeZone: 'Asia/Tashkent',
    now,
    evidence: {
      ...scope,
      policy: displayPolicyFor({ liveQuote: true, availability: true }),
    },
  });
}

describe('business profile (owner 2026-11-23: never a wrong agency name or phone)', () => {
  it('reads the tenant name and the filled profile fields only', () => {
    expect(
      businessProfileOf({
        name: 'Sayohat Tour',
        config: { profile: { phone: '+998 90', hours: ' ', website: '' } },
      }),
    ).toEqual({ name: 'Sayohat Tour', phone: '+998 90' });
    expect(businessProfileOf({ name: 'X', config: { profile: 5 } })).toEqual({
      name: 'X',
    });
  });

  it('renders the stored name, address and phone from their references', () => {
    const result = check(
      '{{F901}} manzili: {{F902}}. Telefon: {{F903}}.',
      profile,
    );
    expect(result.violations).toEqual([]);
    expect(result.rendered).toBe(
      'Sayohat Tour manzili: Toshkent, Amir Temur ko‘chasi. Telefon: +998 90 123 45 67.',
    );
  });

  it('refuses a reference to a detail that is not on file, and a phone typed by the model', () => {
    const missing = check('Ish vaqtimiz: {{F904}}.', profile);
    expect(missing.violations.length).toBeGreaterThan(0);
    expect(missing.rendered).toBeUndefined();
    const typed = check('Telefon: +998 90 123 45 67.', profile);
    expect(typed.violations.length).toBeGreaterThan(0);
    expect(check('Manzil: {{F902}}.', undefined).rendered).toBeUndefined();
  });

  it('tells the model which details exist and to hand the rest to an operator', () => {
    const rule = businessProfileRule(profile);
    expect(rule).toContain('name {{F901}} ("Sayohat Tour")');
    expect(rule).toContain('phone {{F903}}');
    expect(rule).not.toContain('{{F904}}');
    expect(rule).toContain('operator will confirm');
    expect(businessProfileRule(undefined)).toContain('none are on file');
    const prompt = responseSystemPrompt(TRAVEL_PACK, UZ_LATN, profile);
    expect(prompt).toContain('10. Business details');
    expect(prompt).toContain(`11. ${TRAVEL_PACK.prompt.rules[0]}`);
  });
});
