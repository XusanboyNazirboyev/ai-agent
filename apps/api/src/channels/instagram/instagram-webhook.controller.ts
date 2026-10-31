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
import { answerInstagramHandshake, verifyInstagramSignature } from './instagram-signature.js';
import { normalizeInstagramWebhook } from './instagram-normalizer.js';
import { InstagramWebhookService } from './instagram-webhook.service.js';

/**
 * Meta verifies one callback URL per app. POST signatures are checked against
 * Nest's captured raw bytes before normalized events reach durable intake.
 */
@Controller('webhooks/instagram')
export class InstagramWebhookController {
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

  @Post()
  @HttpCode(200)
  async receive(
    @Headers('x-hub-signature-256') signature: string | undefined,
    @Req() request: RawBodyRequest<Request>,
  ): Promise<{ accepted: number; duplicate: number; ignored: number }> {
    const appSecret = this.config.get('INSTAGRAM_APP_SECRET', {
      infer: true,
    });
    if (!appSecret || !request.rawBody) {
      throw new ServiceUnavailableException('Instagram webhook is not configured');
    }
    if (
      !verifyInstagramSignature({
        rawBody: request.rawBody,
        header: signature,
        appSecret,
      })
    ) {
      throw new ForbiddenException('Invalid Instagram webhook signature');
    }

    const normalized = normalizeInstagramWebhook(request.body, new Date());
    if (!normalized.ok) {
      throw new BadRequestException('Malformed Instagram webhook payload');
    }

    let accepted = 0;
    let duplicate = 0;
    let ignored = 0;
    for (const event of normalized.events) {
      if (event.kind === 'ignored') {
        ignored += 1;
        continue;
      }
      const result = await this.webhook.accept(event);
      if (result === 'unavailable') {
        throw new ServiceUnavailableException('Instagram channel is unavailable');
      }
      if (result === 'duplicate') duplicate += 1;
      else accepted += 1;
    }
    return { accepted, duplicate, ignored };
  }
}
