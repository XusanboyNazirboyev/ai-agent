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
import { PlatformSessionService } from './platform-session.service.js';

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

  private async signIn(
    email: string,
    password: string,
    reply: Reply,
  ): Promise<unknown> {
    const result = await this.sessions.login(email, password);
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
    reply.setHeader('Cache-Control', 'no-store');
    return {
      csrfToken: result.csrfToken,
      admin: {
        id: result.admin.id,
        displayName: result.admin.displayName,
        role: result.admin.role,
      },
    };
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
