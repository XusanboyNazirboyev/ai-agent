import { describe, expect, it } from 'vitest';
import {
  assertLocalDevelopment,
  isAllowedWebhookRequest,
} from './dev-guards.js';

const ID = '01a16cb6-c870-77f8-be2b-85dde32e4839';

describe('assertLocalDevelopment', () => {
  it('accepts development on localhost', () => {
    expect(() =>
      assertLocalDevelopment({
        NODE_ENV: 'development',
        POSTGRES_HOST: 'localhost',
      }),
    ).not.toThrow();
  });
  it.each([
    [{ NODE_ENV: 'production', POSTGRES_HOST: 'localhost' }],
    [{ POSTGRES_HOST: 'localhost' }],
    [{ NODE_ENV: 'development', POSTGRES_HOST: 'db.example.com' }],
    [{ NODE_ENV: 'development' }],
  ])('refuses %j', (env) => {
    expect(() => assertLocalDevelopment(env)).toThrow();
  });
});

describe('isAllowedWebhookRequest', () => {
  it('allows only POST of the one webhook path', () => {
    expect(
      isAllowedWebhookRequest('POST', `/webhooks/telegram/${ID}`, ID),
    ).toBe(true);
  });
  it.each([
    ['GET', `/webhooks/telegram/${ID}`],
    ['PUT', `/webhooks/telegram/${ID}`],
    ['POST', '/health'],
    ['POST', '/api/v1/handovers/x/take-over'],
    ['POST', `/webhooks/telegram/${ID}/`],
    ['POST', `/webhooks/telegram/${ID}?x=1`],
    ['POST', `/webhooks/telegram/${ID}/../../health`],
    ['POST', '/webhooks/telegram/other-id'],
    ['POST', undefined],
    [undefined, `/webhooks/telegram/${ID}`],
  ])('refuses %s %s', (method, url) => {
    expect(isAllowedWebhookRequest(method, url, ID)).toBe(false);
  });
});
