import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CLICK_ERROR,
  CLICK_ERROR_NOTE,
  buildClickPayLink,
  clickSignature,
  formatClickAmount,
  parseClickAmount,
  parseClickRequest,
  signatureMatches,
} from './click-rules.js';

const SECRET = 'test-secret-key-not-real';
const form = {
  click_trans_id: '1234567',
  service_id: '9001',
  click_paydoc_id: '7654321',
  merchant_trans_id: '0193a1b2-0000-7000-8000-000000000001',
  amount: '150000.50',
  action: '0',
  error: '0',
  sign_time: '2026-11-19 10:00:00',
  sign_string: 'x',
};
const md5 = (text: string): string =>
  createHash('md5').update(text).digest('hex');

describe('Click signature (docs.click.uz/shop-api/requests)', () => {
  it('Prepare: md5(click_trans_id + service_id + SECRET_KEY + merchant_trans_id + amount + action + sign_time)', () => {
    const request = parseClickRequest(form, false)!;
    const expected = md5(
      '1234567' +
        '9001' +
        SECRET +
        '0193a1b2-0000-7000-8000-000000000001' +
        '150000.50' +
        '0' +
        '2026-11-19 10:00:00',
    );
    expect(clickSignature(request, SECRET, false)).toBe(expected);
    expect(
      signatureMatches({ ...request, signString: expected }, SECRET, false),
    ).toBe(true);
  });

  it('Complete: merchant_prepare_id sits after merchant_trans_id', () => {
    const request = parseClickRequest(
      { ...form, merchant_prepare_id: '42', action: '1' },
      true,
    )!;
    const expected = md5(
      '1234567' +
        '9001' +
        SECRET +
        '0193a1b2-0000-7000-8000-000000000001' +
        '42' +
        '150000.50' +
        '1' +
        '2026-11-19 10:00:00',
    );
    expect(clickSignature(request, SECRET, true)).toBe(expected);
  });

  it('refuses a wrong or different-length signature and a wrong secret', () => {
    const request = parseClickRequest(form, false)!;
    const good = clickSignature(request, SECRET, false);
    expect(
      signatureMatches({ ...request, signString: 'abc' }, SECRET, false),
    ).toBe(false);
    expect(
      signatureMatches({ ...request, signString: good }, 'other', false),
    ).toBe(false);
  });
});

describe('Click request parsing', () => {
  it('needs every documented field; Complete also needs merchant_prepare_id', () => {
    expect(parseClickRequest(form, false)).toBeDefined();
    expect(parseClickRequest(form, true)).toBeUndefined();
    for (const key of Object.keys(form)) {
      const { [key]: _removed, ...rest } = form as Record<string, string>;
      void _removed;
      expect(parseClickRequest(rest, false)).toBeUndefined();
    }
    expect(parseClickRequest(null, false)).toBeUndefined();
    expect(
      parseClickRequest({ ...form, service_id: ['1'] }, false),
    ).toBeUndefined();
    expect(
      parseClickRequest({ ...form, click_trans_id: 'abc' }, false),
    ).toBeUndefined();
  });
});

describe('Click amounts', () => {
  it('formats minor units as N.NN without floating point', () => {
    expect(formatClickAmount(15000000n)).toBe('150000.00');
    expect(formatClickAmount(5n)).toBe('0.05');
    expect(formatClickAmount(10050n)).toBe('100.50');
  });

  it('parses what Click sends into minor units', () => {
    expect(parseClickAmount('150000')).toBe(15000000n);
    expect(parseClickAmount('150000.5')).toBe(15000050n);
    expect(parseClickAmount('150000.50')).toBe(15000050n);
    expect(parseClickAmount('150000.500')).toBe(15000050n);
    expect(parseClickAmount('150000.501')).toBeUndefined();
    expect(parseClickAmount('1e5')).toBeUndefined();
    expect(parseClickAmount('-5')).toBeUndefined();
    expect(parseClickAmount('')).toBeUndefined();
  });
});

describe('Click pay link and error table', () => {
  it('builds the documented link', () => {
    const url = buildClickPayLink({
      serviceId: '9001',
      merchantId: '55',
      amountMinor: 15000000n,
      paymentId: 'abc',
      returnUrl: 'https://app.example/settings/subscription?paid=1',
    });
    expect(url).toBe(
      'https://my.click.uz/services/pay/?service_id=9001&merchant_id=55&amount=150000.00&transaction_param=abc&return_url=https%3A%2F%2Fapp.example%2Fsettings%2Fsubscription%3Fpaid%3D1',
    );
  });

  it('maps every merchant code to the documented note', () => {
    expect(CLICK_ERROR_NOTE[CLICK_ERROR.SIGN_CHECK_FAILED]).toBe(
      'SIGN CHECK FAILED!',
    );
    expect(CLICK_ERROR_NOTE[CLICK_ERROR.INCORRECT_AMOUNT]).toBe(
      'Incorrect parameter amount',
    );
    expect(CLICK_ERROR_NOTE[CLICK_ERROR.ACTION_NOT_FOUND]).toBe(
      'Action not found',
    );
    expect(CLICK_ERROR_NOTE[CLICK_ERROR.ALREADY_PAID]).toBe('Already paid');
    expect(CLICK_ERROR_NOTE[CLICK_ERROR.USER_NOT_FOUND]).toBe(
      'User does not exist',
    );
    expect(CLICK_ERROR_NOTE[CLICK_ERROR.TRANSACTION_NOT_FOUND]).toBe(
      'Transaction does not exist',
    );
    expect(CLICK_ERROR_NOTE[CLICK_ERROR.UPDATE_FAILED]).toBe(
      'Failed to update user',
    );
    expect(CLICK_ERROR_NOTE[CLICK_ERROR.BAD_REQUEST]).toBe(
      'Error in request from click',
    );
    expect(CLICK_ERROR_NOTE[CLICK_ERROR.CANCELLED]).toBe(
      'Transaction cancelled',
    );
    expect(CLICK_ERROR_NOTE[CLICK_ERROR.OK]).toBe('Success');
  });
});
