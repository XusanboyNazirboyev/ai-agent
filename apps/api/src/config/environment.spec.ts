import { describe, expect, it } from 'vitest';
import { validateEnvironment } from './environment';

describe('validateEnvironment', () => {
  it('provides development defaults', () => {
    expect(validateEnvironment({})).toMatchObject({
      NODE_ENV: 'development',
      PORT: 4000,
      LOG_LEVEL: 'info',
    });
  });

  it('coerces a valid port and rejects an invalid port', () => {
    expect(validateEnvironment({ PORT: '8080' }).PORT).toBe(8080);
    expect(() => validateEnvironment({ PORT: '70000' })).toThrow();
  });

  it('rejects malformed service URLs', () => {
    expect(() => validateEnvironment({ REDIS_URL: 'not-a-url' })).toThrow();
  });
});
