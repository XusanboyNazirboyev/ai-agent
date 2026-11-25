import {
  Body,
  Controller,
  HttpCode,
  HttpException,
  HttpStatus,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';
import type { AppEnvironment } from '../config/environment.js';
import {
  LoginRateLimiter,
  tenantLoginReply,
  type Reply,
} from '../webinbox/auth.controller.js';
import {
  loginClientAddress,
  type AddressedRequest,
} from '../webinbox/client-address.js';
import { SessionService } from '../webinbox/session.service.js';
import { platformLoginReply } from './platform-auth.controller.js';
import { PlatformSessionService } from './platform-session.service.js';

const SignInBody = z.object({
  email: z.string().min(3).max(254),
  password: z.string().min(1).max(200),
  /** Sent only after the answer `{ panel: 'choose' }` (ADR 096 Q1). */
  panel: z.enum(['app', 'console']).optional(),
});

type Panel = 'app' | 'console';

const invalid = (locked: boolean): UnauthorizedException =>
  new UnauthorizedException({
    code: locked ? 'LOCKED' : 'INVALID_CREDENTIALS',
    message: 'Invalid email or password',
    i18nKey: locked ? 'errors.accountLocked' : 'errors.invalidCredentials',
  });

/**
 * ADR 096: one sign-in page for the business panel and the console. Both
 * principals, tables, cookies and MFA flows stay as in ADR 047/048; this
 * endpoint only decides which one runs. It lives here because only the
 * platform directory may read platform admins.
 */
@Controller('api/v1/auth')
export class SignInController {
  private readonly limiter: LoginRateLimiter;

  constructor(
    private readonly tenant: SessionService,
    private readonly platform: PlatformSessionService,
    private readonly config: ConfigService<AppEnvironment, true>,
  ) {
    const limit = Number(
      this.config.get('LOGIN_RATE_LIMIT_PER_MINUTE', { infer: true }),
    );
    this.limiter = new LoginRateLimiter(limit > 1 ? limit : 20);
  }

  @Post('sign-in')
  @HttpCode(200)
  async signIn(
    @Body() body: unknown,
    @Req() request: AddressedRequest,
    @Res({ passthrough: true }) reply: Reply,
  ): Promise<unknown> {
    const client = loginClientAddress(
      request,
      this.config.get('WEB_PROXY_SECRET', { infer: true }),
    );
    if (!this.limiter.allow(client))
      throw new HttpException(
        {
          code: 'RATE_LIMITED',
          message: 'Too many attempts',
          i18nKey: 'errors.rateLimited',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    const parsed = SignInBody.safeParse(body);
    if (!parsed.success) throw invalid(false);
    const { email, password, panel } = parsed.data;
    reply.setHeader('Cache-Control', 'no-store');
    if (panel) return this.open(panel, email, password, reply);

    const [tenant, platform] = await Promise.all([
      this.tenant.probe(email, password),
      this.platform.probe(email, password),
    ]);
    const matched: Panel[] = [];
    if (tenant.state === 'match') matched.push('app');
    if (platform.state === 'match') matched.push('console');
    // Q1: both identities accept this password; nothing is opened until the person chooses.
    if (matched.length === 2) return { panel: 'choose' };
    if (matched.length === 1)
      return this.open(matched[0]!, email, password, reply);

    // No identity matched: the failure counts on every identity with this e-mail.
    const outcomes = await Promise.all([
      tenant.state === 'wrong'
        ? this.tenant.recordWrong(tenant.snapshot)
        : undefined,
      platform.state === 'wrong'
        ? this.platform.recordWrong(platform.snapshot)
        : undefined,
    ]);
    throw invalid(
      tenant.state === 'locked' ||
        platform.state === 'locked' ||
        outcomes.includes('locked'),
    );
  }

  /** Runs the chosen principal's own login flow, unchanged (MFA or session cookie). */
  private async open(
    panel: Panel,
    email: string,
    password: string,
    reply: Reply,
  ): Promise<unknown> {
    const secure = Boolean(
      this.config.get('SESSION_COOKIE_SECURE', { infer: true }),
    );
    const body =
      panel === 'app'
        ? tenantLoginReply(
            await this.tenant.login(email, password),
            reply,
            secure,
          )
        : platformLoginReply(
            await this.platform.login(email, password),
            reply,
            secure,
          );
    return { panel, ...(body as object) };
  }
}
