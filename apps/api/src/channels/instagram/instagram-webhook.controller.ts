import {
  Controller,
  ForbiddenException,
  Get,
  Query,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppEnvironment } from '../../config/environment.js';
import { answerInstagramHandshake } from './instagram-signature.js';

/**
 * Meta verifies one callback URL per app. The verification token is shared
 * app configuration, not a customer-provided value. POST delivery is added
 * only when durable intake is wired; this controller currently implements
 * the subscription handshake.
 */
@Controller('webhooks/instagram')
export class InstagramWebhookController {
  constructor(
    private readonly config: ConfigService<AppEnvironment, true>,
  ) {}

  @Get()
  verify(
    @Query('hub.mode') mode: string | undefined,
    @Query('hub.verify_token') verifyToken: string | undefined,
    @Query('hub.challenge') challenge: string | undefined,
  ): string {
    const expectedToken = this.config.get('INSTAGRAM_VERIFY_TOKEN', {
      infer: true,
    });
    const answer = answerInstagramHandshake({
      mode,
      verifyToken,
      challenge,
      expectedToken: expectedToken ?? '',
    });
    if (answer === undefined) {
      throw new ForbiddenException('Invalid Instagram webhook verification');
    }
    return answer;
  }
}
