import {
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { InstagramWebhookController } from './instagram-webhook.controller.js';
import { signInstagramBody } from './instagram-signature.js';

const APP_SECRET = 'test-app-secret';

function makeController(options?: {
  verifyToken?: string;
  appSecret?: string;
  accept?: ReturnType<typeof vi.fn>;
}): {
  controller: InstagramWebhookController;
  webhook: { accept: ReturnType<typeof vi.fn> };
} {
  const config = {
    get: vi.fn((key: string) =>
      key === 'INSTAGRAM_VERIFY_TOKEN'
        ? options?.verifyToken
        : key === 'INSTAGRAM_APP_SECRET'
          ? options?.appSecret
          : undefined,
    ),
  };
  const webhook = {
    accept: options?.accept ?? vi.fn().mockResolvedValue('accepted'),
  };
  return {
    controller: new InstagramWebhookController(
      config as never,
      webhook as never,
    ),
    webhook,
  };
}

describe('InstagramWebhookController GET handshake', () => {
  it('echoes Meta challenge only when the configured token matches', () => {
    const { controller } = makeController({ verifyToken: 'test-verify-token' });
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
    const { controller } = makeController({ verifyToken: 'test-verify-token' });
    expect(() => controller.verify(mode, token, challenge)).toThrow(
      ForbiddenException,
    );
  });

  it('fails closed when the verification token is not configured', () => {
    const { controller } = makeController();
    expect(() =>
      controller.verify('subscribe', 'any-token', 'challenge-123'),
    ).toThrow(ForbiddenException);
  });
});

describe('InstagramWebhookController POST intake', () => {
  const body = {
    object: 'instagram',
    entry: [
      {
        id: '123456',
        messaging: [
          {
            sender: { id: '987654' },
            recipient: { id: '123456' },
            message: { mid: 'mid.1', text: 'Salom' },
          },
        ],
      },
    ],
  };

  function requestFor(rawBody: Buffer, parsedBody: unknown = body): never {
    return { rawBody, body: parsedBody } as never;
  }

  it('rejects when the app secret or raw body is missing', async () => {
    const unconfigured = makeController();
    await expect(
      unconfigured.controller.receive(
        'sha256=bad',
        requestFor(Buffer.from(JSON.stringify(body))),
      ),
    ).rejects.toThrow(ServiceUnavailableException);

    const { controller } = makeController({ appSecret: APP_SECRET });
    await expect(
      controller.receive('sha256=bad', { body } as never),
    ).rejects.toThrow(ServiceUnavailableException);
  });

  it('rejects an invalid signature before intake', async () => {
    const { controller, webhook } = makeController({ appSecret: APP_SECRET });
    const raw = Buffer.from(JSON.stringify(body));
    await expect(
      controller.receive('sha256=' + '0'.repeat(64), requestFor(raw)),
    ).rejects.toThrow(ForbiddenException);
    expect(webhook.accept).not.toHaveBeenCalled();
  });

  it(
    'accepts a correctly signed message and returns intake counts',
    async () => {
      const accept = vi.fn().mockResolvedValue('accepted');
      const { controller } = makeController({ appSecret: APP_SECRET, accept });
      const raw = Buffer.from(JSON.stringify(body));
      const result = await controller.receive(
        signInstagramBody(raw, APP_SECRET),
        requestFor(raw),
      );
      expect(result).toEqual({ accepted: 1, duplicate: 0, ignored: 0 });
      expect(accept).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'text',
          messageId: 'mid.1',
          accountId: '123456',
          customerId: '987654',
          text: 'Salom',
        }),
      );
  });

  it(
    'counts duplicate and ignored events without sending them to intake',
    async () => {
      const accept = vi.fn().mockResolvedValue('duplicate');
      const { controller } = makeController({ appSecret: APP_SECRET, accept });
      const ignoredBody = {
        object: 'instagram',
        entry: [
          {
            id: '123456',
            messaging: [
              {
                sender: { id: '987654' },
                recipient: { id: '123456' },
                message: { mid: 'echo.1', text: 'echo', is_echo: true },
              },
              {
                sender: { id: '987654' },
                recipient: { id: '123456' },
                message: { mid: 'mid.1', text: 'Salom' },
              },
            ],
          },
        ],
      };
      const raw = Buffer.from(JSON.stringify(ignoredBody));
      const result = await controller.receive(
        signInstagramBody(raw, APP_SECRET),
        requestFor(raw, ignoredBody),
      );
      expect(result).toEqual({ accepted: 0, duplicate: 1, ignored: 1 });
      expect(accept).toHaveBeenCalledTimes(1);
  });
});
