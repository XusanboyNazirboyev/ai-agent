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
import { countNewLeadsThisMonth } from '../access/lead-limit.js';
import { openPlanLimits } from '../access/plan-limits.js';
import { canManageTeam } from '../team/team-rules.js';
import { TenantAccessService } from '../access/tenant-access.service.js';
import { OperatorInviteService } from '../team/operator-invite.service.js';
import { PasswordResetService } from '../team/password-reset.service.js';
import { inviteHttpError, passwordResetHttpError } from './team.controller.js';
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

const ResetBody = z.object({ password: z.string().min(10).max(200) });

const LoginBody = z.object({
  email: z.string().min(3).max(254),
  password: z.string().min(1).max(200),
});

export interface Reply {
  setHeader(name: string, value: string | string[]): void;
}

/** Session + CSRF cookies of a fresh tenant login. */
export function tenantCookies(
  session: string,
  csrf: string,
  maxAgeSeconds: number,
  secure: boolean,
): string[] {
  const common = `SameSite=Strict; Path=/; Max-Age=${maxAgeSeconds}${secure ? '; Secure' : ''}`;
  // The CSRF cookie is readable by the page on purpose (double submit): it
  // proves nothing alone, the server compares its hash with the session's.
  return [
    `${SESSION_COOKIE}=${session}; HttpOnly; ${common}`,
    `${CSRF_COOKIE}=${csrf}; ${common}`,
  ];
}

/** Cookies and body of a signed-in browser, or the refusal that explains why not. */
export function tenantLoginReply(
  result: LoginResult,
  reply: Reply,
  secure: boolean,
): unknown {
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
    tenantCookies(result.sessionToken, result.csrfToken, maxAge, secure),
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
    @Optional() private readonly resets?: PasswordResetService,
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
    return tenantCookies(session, csrf, maxAgeSeconds, this.secureCookies());
  }

  private secureCookies(): boolean {
    return Boolean(this.config.get('SESSION_COOKIE_SECURE', { infer: true }));
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

  private sessionReply(result: LoginResult, reply: Reply): unknown {
    return tenantLoginReply(result, reply, this.secureCookies());
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

  /** What the password reset page shows (ADR 047 amendment 2026-11-17). */
  @Get('password-resets/:token')
  async passwordResetPreview(
    @Param('token') token: string,
    @Req() request: AddressedRequest,
    @Res({ passthrough: true }) reply: Reply,
  ): Promise<unknown> {
    if (!this.allowAttempt(request)) throw this.rateLimited();
    reply.setHeader('Cache-Control', 'no-store');
    try {
      return await this.resetService().preview(token);
    } catch (error) {
      throw passwordResetHttpError(error);
    }
  }

  /**
   * Sets a new password with a one-time link. The person is signed out
   * everywhere and signs in again with the new password (and MFA, if on).
   */
  @Post('password-resets/:token')
  @HttpCode(200)
  async completePasswordReset(
    @Param('token') token: string,
    @Body() body: unknown,
    @Req() request: AddressedRequest,
  ): Promise<{ ok: true }> {
    if (!this.allowAttempt(request)) throw this.rateLimited();
    const parsed = ResetBody.safeParse(body);
    if (!parsed.success)
      throw new BadRequestException({
        code: 'INVALID_BODY',
        message: 'Invalid body',
        i18nKey: 'errors.invalidBody',
      });
    try {
      await this.resetService().complete(token, parsed.data.password);
    } catch (error) {
      throw passwordResetHttpError(error);
    }
    return { ok: true };
  }

  private resetService(): PasswordResetService {
    if (!this.resets)
      throw new ServiceUnavailableException({
        code: 'NOT_CONFIGURED',
        message: 'Password reset is not available',
        i18nKey: 'errors.unavailable',
      });
    return this.resets;
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
    // ADR 080: the new-leads banner, for OWNER and ADMIN only; null without a limit.
    let leadLimit: {
      newLeadsThisMonth: number;
      monthlyNewLeads: number;
    } | null = null;
    if (operator && canManageTeam(operator.role) && tenant) {
      const limits = await openPlanLimits(this.prisma, principal.tenantId);
      if (limits.monthlyNewLeads !== undefined)
        leadLimit = {
          newLeadsThisMonth: await countNewLeadsThisMonth(
            this.prisma,
            principal.tenantId,
            tenant.timezone,
            new Date(),
          ),
          monthlyNewLeads: limits.monthlyNewLeads,
        };
    }
    return {
      operator,
      tenant,
      access: {
        state: access?.state ?? 'ok',
        periodEnd: access?.periodEnd ?? null,
        graceUntil: access?.graceUntil ?? null,
      },
      leadLimit,
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
