import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  Res,
  UseGuards,
  UnauthorizedException,
  HttpException,
  HttpStatus,
  ForbiddenException,
  Optional,
  Param,
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';
import type { AppEnvironment } from '../config/environment.js';
import { loginClientAddress, type AddressedRequest } from './client-address.js';
import { PrismaService } from '../persistence/prisma.service.js';
import { TenantAccessService } from '../access/tenant-access.service.js';
import { OperatorInviteService } from '../team/operator-invite.service.js';
import { inviteHttpError } from './team.controller.js';
import {
  CSRF_COOKIE,
  SESSION_COOKIE,
  SessionGuard,
  type InboxRequest,
} from './session.guard.js';
import { SessionService, type LoginResult } from './session.service.js';
import { MfaError, MfaService } from '../auth/mfa.service.js';
import {
  CodeBody,
  DisableBody,
  LoginMfaBody,
  mfaHttpError,
  parseMfaBody,
} from '../auth/mfa-http.js';

const AcceptBody = z.object({
  displayName: z
    .string()
    .transform((value) => value.replace(/\s+/gu, ' ').trim())
    .pipe(z.string().min(1).max(160)),
  password: z.string().min(10).max(200),
});

const LoginBody = z.object({
  email: z.string().min(3).max(254),
  password: z.string().min(1).max(200),
});

interface Reply {
  setHeader(name: string, value: string | string[]): void;
}

/** Fixed-window limiter per client address; the account lock is in the database. */
export class LoginRateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();
  constructor(
    private readonly limit = 20,
    private readonly windowMs = 60_000,
  ) {}

  allow(key: string, now = Date.now()): boolean {
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      if (this.hits.size > 10_000) this.hits.clear();
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    entry.count += 1;
    return entry.count <= this.limit;
  }
}

@Controller('api/v1/auth')
export class AuthController {
  private readonly limiter: LoginRateLimiter;

  constructor(
    private readonly sessions: SessionService,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<AppEnvironment, true>,
    @Optional() private readonly access?: TenantAccessService,
    @Optional() private readonly invites?: OperatorInviteService,
    @Optional() private readonly mfa?: MfaService,
  ) {
    const limit = Number(
      this.config.get('LOGIN_RATE_LIMIT_PER_MINUTE', { infer: true }),
    );
    this.limiter = new LoginRateLimiter(limit > 1 ? limit : 20);
  }

  /** Rate limit by client address (ADR 021); shared with invite acceptance. */
  allowAttempt(request: AddressedRequest): boolean {
    return this.limiter.allow(
      loginClientAddress(
        request,
        this.config.get('WEB_PROXY_SECRET', { infer: true }),
      ),
    );
  }

  /** Session + CSRF cookies of a fresh login. */
  cookies(session: string, csrf: string, maxAgeSeconds: number): string[] {
    const secure = this.config.get('SESSION_COOKIE_SECURE', { infer: true })
      ? '; Secure'
      : '';
    const common = `SameSite=Strict; Path=/; Max-Age=${maxAgeSeconds}${secure}`;
    // The CSRF cookie is readable by the page on purpose (double submit): it
    // proves nothing alone, the server compares its hash with the session's.
    return [
      `${SESSION_COOKIE}=${session}; HttpOnly; ${common}`,
      `${CSRF_COOKIE}=${csrf}; ${common}`,
    ];
  }

  @Post('login')
  @HttpCode(200)
  async login(
    @Body() body: unknown,
    @Req() request: AddressedRequest,
    @Res({ passthrough: true }) reply: Reply,
  ): Promise<unknown> {
    if (!this.allowAttempt(request)) throw this.rateLimited();
    const parsed = LoginBody.safeParse(body);
    if (!parsed.success)
      throw new UnauthorizedException({
        code: 'INVALID_CREDENTIALS',
        message: 'Invalid email or password',
        i18nKey: 'errors.invalidCredentials',
      });
    const result = await this.sessions.login(
      parsed.data.email,
      parsed.data.password,
    );
    return this.sessionReply(result, reply);
  }

  /** Cookies and body of a signed-in browser, or the refusal that explains why not. */
  private sessionReply(result: LoginResult, reply: Reply): unknown {
    reply.setHeader('Cache-Control', 'no-store');
    if (!result.ok && result.code === 'MFA_REQUIRED')
      return { mfaRequired: true, challenge: result.challenge };
    if (!result.ok && result.code === 'MFA_NOT_AVAILABLE')
      throw mfaHttpError(new MfaError('MFA_NOT_AVAILABLE'), true);
    if (!result.ok && result.code === 'TENANT_SUSPENDED')
      throw new ForbiddenException({
        code: 'TENANT_SUSPENDED',
        message: 'This account is suspended',
        i18nKey: 'errors.tenantSuspended',
      });
    if (!result.ok)
      throw new UnauthorizedException({
        code: result.code === 'LOCKED' ? 'LOCKED' : 'INVALID_CREDENTIALS',
        message: 'Invalid email or password',
        i18nKey:
          result.code === 'LOCKED'
            ? 'errors.accountLocked'
            : 'errors.invalidCredentials',
      });
    const maxAge = Math.floor((result.expiresAt.getTime() - Date.now()) / 1000);
    reply.setHeader(
      'Set-Cookie',
      this.cookies(result.sessionToken, result.csrfToken, maxAge),
    );
    return {
      csrfToken: result.csrfToken,
      operator: {
        id: result.principal.operatorId,
        displayName: result.principal.displayName,
        role: result.principal.role,
      },
    };
  }

  /** Second step of a sign-in (ADR 048 §4): the challenge plus a code or recovery code. */
  @Post('login/mfa')
  @HttpCode(200)
  async loginMfa(
    @Body() body: unknown,
    @Req() request: AddressedRequest,
    @Res({ passthrough: true }) reply: Reply,
  ): Promise<unknown> {
    if (!this.allowAttempt(request)) throw this.rateLimited();
    const input = parseMfaBody(LoginMfaBody, body);
    try {
      const result = await this.sessions.loginWithMfa(input.challenge, input);
      return this.sessionReply(result, reply);
    } catch (error) {
      throw mfaHttpError(error, true);
    }
  }

  private mfaService(): MfaService {
    if (!this.mfa) throw mfaHttpError(new MfaError('MFA_NOT_AVAILABLE'), false);
    return this.mfa;
  }

  private subject(request: InboxRequest): {
    kind: 'OPERATOR';
    tenantId: string;
    operatorId: string;
  } {
    const principal = request.principal!;
    return {
      kind: 'OPERATOR',
      tenantId: principal.tenantId,
      operatorId: principal.operatorId,
    };
  }

  @Get('mfa')
  @UseGuards(SessionGuard)
  async mfaStatus(@Req() request: InboxRequest): Promise<unknown> {
    return this.mfaCall(() => this.mfaService().status(this.subject(request)));
  }

  @Post('mfa/setup')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  async mfaSetup(
    @Req() request: InboxRequest,
    @Res({ passthrough: true }) reply: Reply,
  ): Promise<unknown> {
    reply.setHeader('Cache-Control', 'no-store');
    return this.mfaCall(() => this.mfaService().setup(this.subject(request)));
  }

  @Post('mfa/enable')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  async mfaEnable(
    @Body() body: unknown,
    @Req() request: InboxRequest,
    @Res({ passthrough: true }) reply: Reply,
  ): Promise<unknown> {
    reply.setHeader('Cache-Control', 'no-store');
    const input = parseMfaBody(CodeBody, body);
    return this.mfaCall(() =>
      this.mfaService().enable(this.subject(request), input.code),
    );
  }

  @Post('mfa/disable')
  @HttpCode(204)
  @UseGuards(SessionGuard)
  async mfaDisable(
    @Body() body: unknown,
    @Req() request: InboxRequest,
  ): Promise<void> {
    const input = parseMfaBody(DisableBody, body);
    await this.mfaCall(() =>
      this.mfaService().disable(this.subject(request), input.password, input),
    );
  }

  @Post('mfa/recovery-codes')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  async mfaRecoveryCodes(
    @Body() body: unknown,
    @Req() request: InboxRequest,
    @Res({ passthrough: true }) reply: Reply,
  ): Promise<unknown> {
    reply.setHeader('Cache-Control', 'no-store');
    const input = parseMfaBody(CodeBody, body);
    return this.mfaCall(() =>
      this.mfaService().regenerateRecoveryCodes(
        this.subject(request),
        input.code,
      ),
    );
  }

  private async mfaCall<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      throw mfaHttpError(error, false);
    }
  }

  private rateLimited(): HttpException {
    return new HttpException(
      {
        code: 'RATE_LIMITED',
        message: 'Too many attempts',
        i18nKey: 'errors.rateLimited',
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }

  private inviteService(): OperatorInviteService {
    if (!this.invites)
      throw new ServiceUnavailableException({
        code: 'NOT_CONFIGURED',
        message: 'Invites are not available',
        i18nKey: 'errors.unavailable',
      });
    return this.invites;
  }

  /** What the invite page shows; the token itself is the credential. */
  @Get('invites/:token')
  async invitePreview(
    @Param('token') token: string,
    @Req() request: AddressedRequest,
    @Res({ passthrough: true }) reply: Reply,
  ): Promise<unknown> {
    if (!this.allowAttempt(request)) throw this.rateLimited();
    reply.setHeader('Cache-Control', 'no-store');
    try {
      return await this.inviteService().preview(token);
    } catch (error) {
      throw inviteHttpError(error);
    }
  }

  /**
   * Accepts an invite (ADR 047 §5): creates the operator and its login in
   * one transaction, then signs the browser in exactly like `login`.
   */
  @Post('invites/:token/accept')
  @HttpCode(200)
  async acceptInvite(
    @Param('token') token: string,
    @Body() body: unknown,
    @Req() request: AddressedRequest,
    @Res({ passthrough: true }) reply: Reply,
  ): Promise<unknown> {
    if (!this.allowAttempt(request)) throw this.rateLimited();
    const parsed = AcceptBody.safeParse(body);
    if (!parsed.success)
      throw new BadRequestException({
        code: 'INVALID_BODY',
        message: 'Invalid body',
        i18nKey: 'errors.invalidBody',
      });
    let accepted: { email: string };
    try {
      accepted = await this.inviteService().accept(token, parsed.data);
    } catch (error) {
      throw inviteHttpError(error);
    }
    const result = await this.sessions.login(
      accepted.email,
      parsed.data.password,
    );
    return this.sessionReply(result, reply);
  }

  @Get('me')
  @UseGuards(SessionGuard)
  async me(@Req() request: InboxRequest): Promise<unknown> {
    const principal = request.principal!;
    const operator = await this.prisma.operator.findFirst({
      where: { tenantId: principal.tenantId, id: principal.operatorId },
      select: { id: true, displayName: true, role: true },
    });
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: principal.tenantId },
      select: { timezone: true, defaultLocale: true },
    });
    const access = this.access
      ? await this.access.check(principal.tenantId)
      : undefined;
    return {
      operator,
      tenant,
      access: {
        state: access?.state ?? 'ok',
        periodEnd: access?.periodEnd ?? null,
        graceUntil: access?.graceUntil ?? null,
      },
    };
  }

  @Post('logout')
  @HttpCode(204)
  @UseGuards(SessionGuard)
  async logout(
    @Req() request: InboxRequest,
    @Res({ passthrough: true }) reply: Reply,
  ): Promise<void> {
    const principal = request.principal!;
    await this.sessions.logout(principal.sessionId, principal.tenantId);
    reply.setHeader('Set-Cookie', this.cookies('', '', 0));
  }
}
