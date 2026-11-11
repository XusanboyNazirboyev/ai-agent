import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';
import type { AppEnvironment } from '../config/environment.js';
import { PrismaService } from '../persistence/prisma.service.js';
import { LoginRateLimiter } from '../webinbox/auth.controller.js';
import {
  loginClientAddress,
  type AddressedRequest,
} from '../webinbox/client-address.js';
import { hashPassword } from '../webinbox/password.js';
import { hashInviteToken, plausibleInviteToken } from '../team/invite-token.js';
import { recordPlatformAudit } from './platform-audit.js';
import { parseBody } from './platform-http.js';
import {
  PLATFORM_COOKIE,
  PLATFORM_CSRF_COOKIE,
  PlatformAccessLevel,
  PlatformSessionGuard,
  type PlatformRequest,
} from './platform-session.guard.js';
import {
  PlatformSessionService,
  type PlatformLoginResult,
} from './platform-session.service.js';
import { MfaError, MfaService } from '../auth/mfa.service.js';
import {
  ChallengeBody,
  CodeBody,
  DisableBody,
  EnrollEnableBody,
  LoginMfaBody,
  mfaHttpError,
  parseMfaBody,
} from '../auth/mfa-http.js';

const LoginBody = z.object({
  email: z.string().min(3).max(254),
  password: z.string().min(1).max(200),
});

const AcceptBody = z.object({
  displayName: z
    .string()
    .transform((value) => value.replace(/\s+/gu, ' ').trim())
    .pipe(z.string().min(1).max(160))
    .optional(),
  password: z.string().min(12).max(200),
});

interface Reply {
  setHeader(name: string, value: string | string[]): void;
}

/** Platform console sign-in (ADR 047 §1); cookies `ac_platform*`. */
@Controller('api/v1/platform/auth')
export class PlatformAuthController {
  private readonly limiter: LoginRateLimiter;

  constructor(
    private readonly sessions: PlatformSessionService,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<AppEnvironment, true>,
    private readonly mfa: MfaService,
  ) {
    const limit = Number(
      this.config.get('LOGIN_RATE_LIMIT_PER_MINUTE', { infer: true }),
    );
    this.limiter = new LoginRateLimiter(limit > 1 ? limit : 20);
  }

  private allow(request: AddressedRequest): void {
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
  }

  private cookies(session: string, csrf: string, maxAge: number): string[] {
    const secure = this.config.get('SESSION_COOKIE_SECURE', { infer: true })
      ? '; Secure'
      : '';
    const common = `SameSite=Strict; Path=/; Max-Age=${maxAge}${secure}`;
    return [
      `${PLATFORM_COOKIE}=${session}; HttpOnly; ${common}`,
      `${PLATFORM_CSRF_COOKIE}=${csrf}; ${common}`,
    ];
  }

  /** Cookies and body of a signed-in browser, or the next step / refusal. */
  private reply(
    result: PlatformLoginResult,
    reply: Reply,
    extra: Record<string, unknown> = {},
  ): unknown {
    reply.setHeader('Cache-Control', 'no-store');
    if (!result.ok && result.code === 'MFA_REQUIRED')
      return { mfaRequired: true, challenge: result.challenge };
    if (!result.ok && result.code === 'MFA_ENROLLMENT_REQUIRED')
      return { mfaEnrollmentRequired: true, challenge: result.challenge };
    if (!result.ok && result.code === 'MFA_NOT_AVAILABLE')
      throw mfaHttpError(new MfaError('MFA_NOT_AVAILABLE'), true);
    if (!result.ok)
      throw new UnauthorizedException({
        code: result.code,
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
      admin: {
        id: result.admin.id,
        displayName: result.admin.displayName,
        role: result.admin.role,
      },
      ...extra,
    };
  }

  private async signIn(
    email: string,
    password: string,
    reply: Reply,
  ): Promise<unknown> {
    return this.reply(await this.sessions.login(email, password), reply);
  }

  /** Second step of a sign-in (ADR 048 §4). */
  @Post('login/mfa')
  @HttpCode(200)
  async loginMfa(
    @Body() body: unknown,
    @Req() request: AddressedRequest,
    @Res({ passthrough: true }) reply: Reply,
  ): Promise<unknown> {
    this.allow(request);
    const input = parseMfaBody(LoginMfaBody, body);
    try {
      return this.reply(
        await this.sessions.loginWithMfa(input.challenge, input),
        reply,
      );
    } catch (error) {
      throw mfaHttpError(error, true);
    }
  }

  /** Forced enrolment (ADR 048 §5), step 1: a secret for the challenge's admin. */
  @Post('login/mfa/setup')
  @HttpCode(200)
  async enrollSetup(
    @Body() body: unknown,
    @Req() request: AddressedRequest,
    @Res({ passthrough: true }) reply: Reply,
  ): Promise<unknown> {
    this.allow(request);
    const input = parseMfaBody(ChallengeBody, body);
    reply.setHeader('Cache-Control', 'no-store');
    try {
      return await this.mfa.setup(
        await this.mfa.enrollSubject(input.challenge),
      );
    } catch (error) {
      throw mfaHttpError(error, true);
    }
  }

  /** Forced enrolment, step 2: confirms the code, opens the session, returns the recovery codes once. */
  @Post('login/mfa/enable')
  @HttpCode(200)
  async enrollEnable(
    @Body() body: unknown,
    @Req() request: AddressedRequest,
    @Res({ passthrough: true }) reply: Reply,
  ): Promise<unknown> {
    this.allow(request);
    const input = parseMfaBody(EnrollEnableBody, body);
    try {
      const result = await this.sessions.enrollAndLogin(
        input.challenge,
        input.code,
      );
      return this.reply(result, reply, {
        recoveryCodes: result.recoveryCodes,
      });
    } catch (error) {
      throw mfaHttpError(error, true);
    }
  }

  private subject(request: PlatformRequest): {
    kind: 'PLATFORM';
    adminId: string;
  } {
    return { kind: 'PLATFORM', adminId: request.platform!.adminId };
  }

  private async mfaCall<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      throw mfaHttpError(error, false);
    }
  }

  @Get('mfa')
  @UseGuards(PlatformSessionGuard)
  async mfaStatus(@Req() request: PlatformRequest): Promise<unknown> {
    return this.mfaCall(() => this.mfa.status(this.subject(request)));
  }

  @Post('mfa/setup')
  @HttpCode(200)
  @PlatformAccessLevel('self')
  @UseGuards(PlatformSessionGuard)
  async mfaSetup(
    @Req() request: PlatformRequest,
    @Res({ passthrough: true }) reply: Reply,
  ): Promise<unknown> {
    reply.setHeader('Cache-Control', 'no-store');
    return this.mfaCall(() => this.mfa.setup(this.subject(request)));
  }

  @Post('mfa/enable')
  @HttpCode(200)
  @PlatformAccessLevel('self')
  @UseGuards(PlatformSessionGuard)
  async mfaEnable(
    @Body() body: unknown,
    @Req() request: PlatformRequest,
    @Res({ passthrough: true }) reply: Reply,
  ): Promise<unknown> {
    reply.setHeader('Cache-Control', 'no-store');
    const input = parseMfaBody(CodeBody, body);
    return this.mfaCall(() =>
      this.mfa.enable(this.subject(request), input.code),
    );
  }

  /** Always refused for platform admins: MFA is enforced (ADR 048 §6). */
  @Post('mfa/disable')
  @HttpCode(204)
  @PlatformAccessLevel('self')
  @UseGuards(PlatformSessionGuard)
  async mfaDisable(
    @Body() body: unknown,
    @Req() request: PlatformRequest,
  ): Promise<void> {
    const input = parseMfaBody(DisableBody, body);
    await this.mfaCall(() =>
      this.mfa.disable(this.subject(request), input.password, input),
    );
  }

  @Post('mfa/recovery-codes')
  @HttpCode(200)
  @PlatformAccessLevel('self')
  @UseGuards(PlatformSessionGuard)
  async mfaRecoveryCodes(
    @Body() body: unknown,
    @Req() request: PlatformRequest,
    @Res({ passthrough: true }) reply: Reply,
  ): Promise<unknown> {
    reply.setHeader('Cache-Control', 'no-store');
    const input = parseMfaBody(CodeBody, body);
    return this.mfaCall(() =>
      this.mfa.regenerateRecoveryCodes(this.subject(request), input.code),
    );
  }

  @Post('login')
  @HttpCode(200)
  async login(
    @Body() body: unknown,
    @Req() request: AddressedRequest,
    @Res({ passthrough: true }) reply: Reply,
  ): Promise<unknown> {
    this.allow(request);
    const parsed = LoginBody.safeParse(body);
    if (!parsed.success)
      throw new UnauthorizedException({
        code: 'INVALID_CREDENTIALS',
        message: 'Invalid email or password',
        i18nKey: 'errors.invalidCredentials',
      });
    return this.signIn(parsed.data.email, parsed.data.password, reply);
  }

  /** Sets the password of an invited platform admin and signs in. */
  @Post('invites/:token/accept')
  @HttpCode(200)
  async accept(
    @Param('token') token: string,
    @Body() body: unknown,
    @Req() request: AddressedRequest,
    @Res({ passthrough: true }) reply: Reply,
  ): Promise<unknown> {
    this.allow(request);
    const input = parseBody(AcceptBody, body);
    const invalid = new NotFoundException({
      code: 'INVITE_INVALID',
      message: 'Invite refused',
      i18nKey: 'platform.errors.INVITE_INVALID',
    });
    if (!plausibleInviteToken(token)) throw invalid;
    const now = new Date();
    const passwordHash = await hashPassword(
      input.password,
      this.sessions.policy.scrypt,
    );
    const email = await this.prisma.$transaction(async (tx) => {
      const admin = await tx.platformAdmin.findFirst({
        where: {
          inviteTokenHash: hashInviteToken(token),
          inviteExpiresAt: { gt: now },
          isActive: true,
        },
      });
      if (!admin) return undefined;
      const updated = await tx.platformAdmin.updateMany({
        where: { id: admin.id, inviteTokenHash: admin.inviteTokenHash },
        data: {
          passwordHash,
          inviteTokenHash: null,
          inviteExpiresAt: null,
          failedAttempts: 0,
          lockedUntil: null,
          ...(input.displayName ? { displayName: input.displayName } : {}),
        },
      });
      if (updated.count !== 1) return undefined;
      await recordPlatformAudit(tx, {
        actorAdminId: admin.id,
        action: 'admin.invite_accepted',
        entityType: 'platform_admin',
        entityId: admin.id,
      });
      return admin.email;
    });
    if (!email) throw invalid;
    return this.signIn(email, input.password, reply);
  }

  @Get('me')
  @UseGuards(PlatformSessionGuard)
  async me(@Req() request: PlatformRequest): Promise<unknown> {
    const admin = await this.prisma.platformAdmin.findUnique({
      where: { id: request.platform!.adminId },
      select: { id: true, email: true, displayName: true, role: true },
    });
    return { admin };
  }

  @Post('logout')
  @HttpCode(204)
  @PlatformAccessLevel('self')
  @UseGuards(PlatformSessionGuard)
  async logout(
    @Req() request: PlatformRequest,
    @Res({ passthrough: true }) reply: Reply,
  ): Promise<void> {
    await this.sessions.logout(request.platform!.sessionId);
    reply.setHeader('Set-Cookie', this.cookies('', '', 0));
  }
}
