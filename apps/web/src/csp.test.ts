import { describe, expect, it } from 'vitest';
import { contentSecurityPolicy, newNonce } from './csp';

const directive = (policy: string, name: string): string =>
  policy.split('; ').find((part) => part.startsWith(`${name} `)) ?? '';

describe('content security policy', () => {
  const nonce = 'abc123';

  it('production: nonce-only scripts and styles, nothing inline or eval', () => {
    const policy = contentSecurityPolicy(nonce, false);
    expect(directive(policy, 'script-src')).toBe(
      "script-src 'self' 'nonce-abc123' 'strict-dynamic'",
    );
    expect(directive(policy, 'style-src')).toBe(
      "style-src 'self' 'nonce-abc123'",
    );
    expect(policy).not.toContain('unsafe-inline');
    expect(policy).not.toContain('unsafe-eval');
  });

  it('every mode keeps the structural protections', () => {
    for (const dev of [true, false]) {
      const policy = contentSecurityPolicy(nonce, dev);
      for (const part of [
        "default-src 'self'",
        "object-src 'none'",
        "frame-ancestors 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "connect-src 'self'",
      ])
        expect(policy).toContain(part);
    }
  });

  it('development: scripts stay nonce-only; only the dev tooling exceptions differ', () => {
    const policy = contentSecurityPolicy(nonce, true);
    expect(directive(policy, 'script-src')).toBe(
      "script-src 'self' 'nonce-abc123' 'strict-dynamic' 'unsafe-eval'",
    );
    expect(directive(policy, 'script-src')).not.toContain('unsafe-inline');
    // No nonce next to 'unsafe-inline': browsers would ignore the keyword.
    expect(directive(policy, 'style-src')).toBe(
      "style-src 'self' 'unsafe-inline'",
    );
  });

  it('creates a fresh 128-bit nonce each time', () => {
    const a = newNonce();
    expect(atob(a)).toHaveLength(16);
    expect(newNonce()).not.toBe(a);
  });
});
