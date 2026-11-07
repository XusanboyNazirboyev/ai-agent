import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  Post,
  Query,
  Req,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import type { AppEnvironment } from '../../config/environment.js';
import { InstagramWebhookService } from '../instagram/instagram-webhook.service.js';
import {
  answerMetaHandshake,
  verifyMetaSignature,
} from '../meta/meta-webhook-auth.js';
import { normalizeFacebookWebhook } from './facebook-normalizer.js';

/**
 * Messenger webhooks (ADR 040, `object: "page"`). The same Meta app signs
 * Instagram and Messenger deliveries with its App Secret
 * (`INSTAGRAM_APP_SECRET` holds the Meta app's secret) and uses the same
 * verify token; the signature is checked on Nest's captured raw bytes before
 * anything reaches the shared durable intake.
 */
@Controller('webhooks/facebook')
export class FacebookWebhookController {
  constructor(
    private readonly config: ConfigService<AppEnvironment, true>,
    private readonly webhook: InstagramWebhookService,
  ) {}

  @Get()
  verify(
    @Query('hub.mode') mode: string | undefined,
    @Query('hub.verify_token') verifyToken: string | undefined,
    @Query('hub.challenge') challenge: string | undefined,
  ): string {
    const answer = answerMetaHandshake({
      mode,
      verifyToken,
      challenge,
      expectedToken:
        this.config.get('INSTAGRAM_VERIFY_TOKEN', { infer: true }) ?? '',
    });
    if (answer === undefined)
      throw new ForbiddenException('Invalid Facebook webhook verification');
    return answer;
  }

  @Post()
  @HttpCode(200)
  async receive(
    @Headers('x-hub-signature-256') signature: string | undefined,
    @Req() request: RawBodyRequest<Request>,
  ): Promise<{ accepted: number; duplicate: number; ignored: number }> {
    const appSecret = this.config.get('INSTAGRAM_APP_SECRET', { infer: true });
    if (!appSecret || !request.rawBody)
      throw new ServiceUnavailableException(
        'Facebook webhook is not configured',
      );
    if (
      !verifyMetaSignature({
        rawBody: request.rawBody,
        header: signature,
        appSecret,
      })
    )
      throw new ForbiddenException('Invalid Facebook webhook signature');

    const normalized = normalizeFacebookWebhook(request.body, new Date());
    if (!normalized.ok)
      throw new BadRequestException('Malformed Facebook webhook payload');

    let accepted = 0;
    let duplicate = 0;
    let ignored = 0;
    for (const event of normalized.events) {
      if (event.kind === 'ignored') {
        ignored += 1;
        continue;
      }
      const result = await this.webhook.accept(event, 'facebook');
      if (result === 'unavailable')
        throw new ServiceUnavailableException('Facebook Page is unavailable');
      if (result === 'duplicate') duplicate += 1;
      else accepted += 1;
    }
    return { accepted, duplicate, ignored };
  }
}
