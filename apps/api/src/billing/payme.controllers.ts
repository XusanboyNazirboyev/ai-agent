import {
  Body,
  All,
  Controller,
  ForbiddenException,
  Headers,
  HttpCode,
  HttpException,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { LoginRateLimiter } from '../webinbox/auth.controller.js';
import { SessionGuard, type InboxRequest } from '../webinbox/session.guard.js';
import { CheckoutError } from './click-payments.service.js';
import {
  PaymePaymentsService,
  type PaymeAnswer,
} from './payme-payments.service.js';

const CheckoutBody = z
  .object({
    planCode: z.string().min(1).max(60),
    locale: z.enum(['en', 'ru', 'uz']),
  })
  .strict();

/** OWNER/ADMIN starts a Payme checkout; amount and account stay server-owned. */
@Controller('api/v1/billing/payme')
@UseGuards(SessionGuard)
export class PaymeCheckoutController {
  private readonly limiter = new LoginRateLimiter(10);

  constructor(private readonly payme: PaymePaymentsService) {}

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
      const { url } = await this.payme.checkout(
        principal.tenantId,
        parsed.data.planCode,
        parsed.data.locale,
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

/** Public Payme Merchant API endpoint; Basic Auth is checked by the service. */
@Controller('api/v1/payments/payme')
export class PaymeCallbackController {
  constructor(private readonly payme: PaymePaymentsService) {}

  @Post()
  @HttpCode(200)
  callback(
    @Body() body: unknown,
    @Headers('authorization') authorization?: string,
  ): Promise<PaymeAnswer> {
    return this.payme.handle(body, authorization);
  }

  @All()
  @HttpCode(200)
  wrongMethod(
    @Body() body: unknown,
    @Headers('authorization') authorization?: string,
  ): PaymeAnswer {
    return this.payme.wrongHttpMethod(body, authorization);
  }
}
