import { ForbiddenException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { InstagramWebhookController } from './instagram-webhook.controller.js';

describe('InstagramWebhookController', () => {
  it('echoes Meta challenge only when the configured token matches', () => {
    const config = {
      get: vi.fn(() => 'test-verify-token'),
    };
    const controller = new InstagramWebhookController(config as never);

    expect(
      controller.verify('subscribe', 'test-verify-token', 'challenge-123'),
    ).toBe('challenge-123');
  });

  it.each([
    ['wrong mode', 'unsubscribe', 'test-verify-token', 'challenge-123'],
    ['wrong token', 'subscribe', 'wrong-token', 'challenge-123'],
    ['missing token', 'subscribe', undefined, 'challenge-123'],
    ['missing challenge', 'subscribe', 'test-verify-token', undefined],
  ])('rejects %s', (_case, mode, token, challenge) => {
    const config = { get: vi.fn(() => 'test-verify-token') };
    const controller = new InstagramWebhookController(config as never);

    expect(() => controller.verify(mode, token, challenge)).toThrow(
      ForbiddenException,
    );
  });

  it('fails closed when the verification token is not configured', () => {
    const config = { get: vi.fn(() => undefined) };
    const controller = new InstagramWebhookController(config as never);

    expect(() =>
      controller.verify('subscribe', 'any-token', 'challenge-123'),
    ).toThrow(ForbiddenException);
  });
});
