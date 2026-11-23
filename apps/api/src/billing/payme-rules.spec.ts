import { describe, expect, it } from 'vitest';
import {
  PAYME_CHECKOUT_URL,
  buildPaymeCheckoutLink,
  paymeAuthorizationMatches,
} from './payme-rules.js';

describe('Payme protocol rules', () => {
  it('builds the documented base64 checkout parameters in tiyin', () => {
    const url = buildPaymeCheckoutLink({
      merchantId: '507f1f77bcf86cd799439011',
      paymentId: '019ab123-4567-789a-bcde-f0123456789a',
      amountMinor: 15_000_000n,
      locale: 'uz',
      returnUrl: 'https://app.example.test/billing?paid=1',
    });
    expect(url.startsWith(`${PAYME_CHECKOUT_URL}/`)).toBe(true);
    expect(
      Buffer.from(url.slice(PAYME_CHECKOUT_URL.length + 1), 'base64').toString(
        'utf8',
      ),
    ).toBe(
      'm=507f1f77bcf86cd799439011;' +
        'ac.order_id=019ab123-4567-789a-bcde-f0123456789a;' +
        'a=15000000;l=uz;' +
        'c=https://app.example.test/billing?paid=1;' +
        'ct=15000;cr=0',
    );
  });

  it('checks the complete Basic credential without accepting prefixes', () => {
    const good = `Basic ${Buffer.from('Paycom:fake-key').toString('base64')}`;
    expect(paymeAuthorizationMatches(good, 'Paycom', 'fake-key')).toBe(true);
    expect(paymeAuthorizationMatches(good, 'Pay', 'fake-key')).toBe(false);
    expect(paymeAuthorizationMatches(good, 'Paycom', 'fake')).toBe(false);
    expect(
      paymeAuthorizationMatches('Bearer fake-key', 'Paycom', 'fake-key'),
    ).toBe(false);
  });
});
