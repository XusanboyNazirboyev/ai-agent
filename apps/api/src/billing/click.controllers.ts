import {
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  HttpException,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { LoginRateLimiter } from '../webinbox/auth.controller.js';
import { SessionGuard, type InboxRequest } from '../webinbox/session.guard.js';
import type { ClickAnswer } from './click-rules.js';
import {
  CheckoutError,
  ClickPaymentsService,
} from './click-payments.service.js';

const CheckoutBody = z.object({ planCode: z.string().min(1).max(60) }).strict();

/** The pay button (ADR 082): OWNER and ADMIN, session and CSRF via the guard. */
@Controller('api/v1/billing/click')
@UseGuards(SessionGuard)
export class ClickCheckoutController {
  private readonly limiter = new LoginRateLimiter(10);

  constructor(private readonly click: ClickPaymentsService) {}

  @Post('checkout')
  @HttpCode(200)
  async checkout(
    @Req() request: InboxRequest,
    @Body() body: unknown,
  ): Promise<{ url: string }> {
    const principal = request.principal!;
    if (principal.role !== 'OWNER' && principal.role !== 'ADMIN')
      throw new ForbiddenException({
        code: 'FORBIDDEN',
        message: 'Not allowed',
        i18nKey: 'errors.forbidden',
      });
    if (!this.limiter.allow(principal.tenantId))
      throw new HttpException(
        {
          code: 'RATE_LIMITED',
          message: 'Too many requests',
          i18nKey: 'errors.rateLimited',
        },
        429,
      );
    const parsed = CheckoutBody.safeParse(body);
    if (!parsed.success)
      throw new HttpException(
        {
          code: 'INVALID_BODY',
          message: 'Invalid request',
          i18nKey: 'errors.invalidBody',
        },
        400,
      );
    try {
      const { url } = await this.click.checkout(
        principal.tenantId,
        parsed.data.planCode,
      );
      return { url };
    } catch (error) {
      if (error instanceof CheckoutError)
        throw new HttpException(
          {
            code: error.code,
            message: 'Checkout refused',
            i18nKey: `billing.errors.${error.code}`,
          },
          error.code === 'NOT_CONFIGURED' ? 409 : 400,
        );
      throw error;
    }
  }
}

/**
 * Click's Shop API callbacks (ADR 082): public, form-urlencoded, no session
 * or CSRF (the signature is the authentication). Always HTTP 200 with a JSON
 * answer; the outcome is in `error`.
 */
@Controller('api/v1/payments/click')
export class ClickCallbackController {
  constructor(private readonly click: ClickPaymentsService) {}

  @Post('prepare')
  @HttpCode(200)
  prepare(@Body() body: unknown): Promise<ClickAnswer> {
    return this.click.handle(body, false);
  }

  @Post('complete')
  @HttpCode(200)
  complete(@Body() body: unknown): Promise<ClickAnswer> {
    return this.click.handle(body, true);
  }
}
