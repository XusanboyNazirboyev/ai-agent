import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  HttpException,
  HttpStatus,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
  ServiceUnavailableException,
  ConflictException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';
import { TelegramBusinessService } from '../channels/telegram/telegram-business.service.js';
import { SIGNUP_PACK_KEYS, SIGNUP_PACK_OPTIONS } from '../packs/registry.js';
import { PlatformBotSender } from './platform-bot.sender.js';
import type { AppEnvironment } from '../config/environment.js';
import {
  loginClientAddress,
  type AddressedRequest,
} from '../webinbox/client-address.js';
import { LoginRateLimiter } from '../webinbox/auth.controller.js';
import {
  CSRF_COOKIE,
  SESSION_COOKIE,
  readCookie,
} from '../webinbox/session.guard.js';
import { SessionService } from '../webinbox/session.service.js';
import {
  SignupError,
  SignupService,
  type CreatedSignup,
} from './signup.service.js';
import {
  constantTimeEqual,
  platformWebhookPathSecret,
  SIGNUP_TTL_MS,
} from './signup-rules.js';

const Squash = (max: number, min = 1): z.ZodType<string, string> =>
  z
    .string()
    .transform((value) => value.replace(/\s+/gu, ' ').trim())
    .pipe(z.string().min(min).max(max));

/** Same password policy as invites (ADR 047 §5). */
const CreateBody = z.object({
  businessName: Squash(120, 2),
  name: Squash(80),
  email: z.string().min(3).max(254),
  password: z.string().min(10).max(200),
  planCode: z.string().min(1).max(60),
  // Owner 2026-11-23: the business type decides the Domain Pack.
  packKey: z.string().refine((key) => SIGNUP_PACK_KEYS.includes(key)),
});

export const BINDING_COOKIE = 'tezda_signup';

interface Reply {
  setHeader(name: string, value: string | string[]): void;
}

interface CookieRequest extends AddressedRequest {
  headers: AddressedRequest['headers'] & { origin?: string; cookie?: string };
}

function fail(
  Type: new (body: object) => HttpException,
  code: string,
): HttpException {
  return new Type({
    code,
    message: 'Signup refused',
    i18nKey: `signup.errors.${code}`,
  });
}

/** Public signup API (ADR 080): no session, rate limited per address. */
@Controller('api/v1/public/signups')
export class SignupController {
  private readonly createLimiter: LoginRateLimiter;
  private readonly pollLimiter: LoginRateLimiter;

  constructor(
    private readonly signups: SignupService,
    private readonly sessions: SessionService,
    private readonly config: ConfigService<AppEnvironment, true>,
  ) {
    const limit = Number(
      this.config.get('LOGIN_RATE_LIMIT_PER_MINUTE', { infer: true }),
    );
    this.createLimiter = new LoginRateLimiter(limit > 1 ? limit : 20);
    this.pollLimiter = new LoginRateLimiter(limit > 1 ? limit * 6 : 120);
  }

  private address(request: AddressedRequest): string {
    return loginClientAddress(
      request,
      this.config.get('WEB_PROXY_SECRET', { infer: true }),
    );
  }

  private tooMany(): HttpException {
    return new HttpException(
      {
        code: 'RATE_LIMITED',
        message: 'Too many attempts',
        i18nKey: 'errors.rateLimited',
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }

  private checkOrigin(request: CookieRequest): void {
    const origin = request.headers.origin;
    const allowed = this.config.get('WEB_ORIGINS', { infer: true });
    if (typeof origin === 'string' && !allowed.includes(origin))
      throw new ForbiddenException({
        code: 'BAD_ORIGIN',
        message: 'Request refused',
        i18nKey: 'errors.forbidden',
      });
  }

  private cookieOptions(maxAgeSeconds: number): string {
    const secure = this.config.get('SESSION_COOKIE_SECURE', { infer: true })
      ? '; Secure'
      : '';
    return `SameSite=Strict; Path=/; Max-Age=${maxAgeSeconds}${secure}`;
  }

  @Post()
  @HttpCode(201)
  async create(
    @Body() body: unknown,
    @Req() request: CookieRequest,
    @Res({ passthrough: true }) reply: Reply,
  ): Promise<{ id: string; telegramUrl: string; expiresAt: string }> {
    this.checkOrigin(request);
    if (!this.createLimiter.allow(this.address(request))) throw this.tooMany();
    reply.setHeader('Cache-Control', 'no-store');
    const parsed = CreateBody.safeParse(body);
    if (!parsed.success)
      throw new BadRequestException({
        code: 'INVALID_BODY',
        message: 'Invalid body',
        i18nKey: 'errors.invalidBody',
      });
    let created: CreatedSignup;
    try {
      created = await this.signups.create(parsed.data);
    } catch (error) {
      if (error instanceof SignupError) {
        if (error.code === 'SIGNUP_UNAVAILABLE')
          throw fail(ServiceUnavailableException, error.code);
        if (error.code === 'EMAIL_TAKEN')
          throw fail(ConflictException, error.code);
        throw fail(BadRequestException, error.code);
      }
      throw error;
    }
    reply.setHeader(
      'Set-Cookie',
      `${BINDING_COOKIE}=${created.binding}; HttpOnly; ${this.cookieOptions(
        Math.floor(SIGNUP_TTL_MS / 1000) + 600,
      )}`,
    );
    return {
      id: created.id,
      telegramUrl: created.telegramUrl,
      expiresAt: created.expiresAt.toISOString(),
    };
  }

  @Get('options')
  options(@Res({ passthrough: true }) reply: Reply): {
    businessTypes: typeof SIGNUP_PACK_OPTIONS;
  } {
    reply.setHeader('Cache-Control', 'public, max-age=300');
    return { businessTypes: SIGNUP_PACK_OPTIONS };
  }

  /** Polled by the signup page; signs this browser in once when confirmed. */
  @Get(':id')
  async status(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() request: CookieRequest,
    @Res({ passthrough: true }) reply: Reply,
  ): Promise<unknown> {
    if (!this.pollLimiter.allow(this.address(request))) throw this.tooMany();
    reply.setHeader('Cache-Control', 'no-store');
    const view = await this.signups.status(
      id,
      readCookie(request.headers.cookie, BINDING_COOKIE),
    );
    if (!view)
      throw new NotFoundException({
        code: 'NOT_FOUND',
        message: 'Not found',
        i18nKey: 'errors.notFound',
      });
    if (view.status === 'REFUSED')
      return { status: 'REFUSED', reason: view.reason };
    if (view.status !== 'CONFIRMED') return { status: view.status };
    if (!view.session) return { status: 'CONFIRMED', signedIn: false };
    const result = await this.sessions.openSession(
      view.session.tenantId,
      view.session.operatorId,
    );
    if (!result.ok) return { status: 'CONFIRMED', signedIn: false };
    const maxAge = Math.floor((result.expiresAt.getTime() - Date.now()) / 1000);
    const options = this.cookieOptions(maxAge);
    reply.setHeader('Set-Cookie', [
      `${SESSION_COOKIE}=${result.sessionToken}; HttpOnly; ${options}`,
      `${CSRF_COOKIE}=${result.csrfToken}; ${options}`,
      `${BINDING_COOKIE}=; HttpOnly; ${this.cookieOptions(0)}`,
    ]);
    return {
      status: 'CONFIRMED',
      signedIn: true,
      csrfToken: result.csrfToken,
    };
  }
}

/** The platform bot's webhook (ADR 080); the path and the header both carry a secret. */
@Controller('webhooks/platform-telegram')
export class PlatformTelegramWebhookController {
  constructor(
    private readonly signups: SignupService,
    private readonly config: ConfigService<AppEnvironment, true>,
    private readonly business: TelegramBusinessService,
    private readonly bot: PlatformBotSender,
  ) {}

  @Post(':pathSecret')
  @HttpCode(200)
  async receive(
    @Param('pathSecret') pathSecret: string,
    @Headers('x-telegram-bot-api-secret-token') header: string | undefined,
    @Body() body: unknown,
  ): Promise<{ ok: true }> {
    const secret = this.config.get('PLATFORM_TELEGRAM_WEBHOOK_SECRET', {
      infer: true,
    });
    if (!secret || !this.signups.configured)
      throw new ServiceUnavailableException('Platform bot is not configured');
    // Both checks run before either result is used (constant time each).
    const pathOk = constantTimeEqual(
      pathSecret,
      platformWebhookPathSecret(secret),
    );
    const headerOk = constantTimeEqual(header, secret);
    if (!pathOk || !headerOk)
      throw new ForbiddenException({ code: 'BAD_WEBHOOK_SECRET' });
    // ADR 092: Telegram Business updates and `/start biz…` links first.
    const business = await this.business.handleUpdate(body);
    if (!business.handled) await this.signups.handleUpdate(body);
    else if (business.reply)
      await this.bot.send(business.reply.chatId, business.reply.text);
    return { ok: true };
  }
}
