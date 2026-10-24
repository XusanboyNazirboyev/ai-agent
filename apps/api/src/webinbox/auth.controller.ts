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
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';
import type { AppEnvironment } from '../config/environment.js';
import { PrismaService } from '../persistence/prisma.service.js';
import {
  CSRF_COOKIE,
  SESSION_COOKIE,
  SessionGuard,
  type InboxRequest,
} from './session.guard.js';
import { SessionService } from './session.service.js';

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
  private readonly limiter = new LoginRateLimiter();

  constructor(
    private readonly sessions: SessionService,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<AppEnvironment, true>,
  ) {}

  private cookies(
    session: string,
    csrf: string,
    maxAgeSeconds: number,
  ): string[] {
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
    @Req() request: { ip?: string },
    @Res({ passthrough: true }) reply: Reply,
  ): Promise<unknown> {
    if (!this.limiter.allow(request.ip ?? 'unknown'))
      throw new HttpException(
        {
          code: 'RATE_LIMITED',
          message: 'Too many attempts',
          i18nKey: 'errors.rateLimited',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
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
    reply.setHeader('Cache-Control', 'no-store');
    return {
      csrfToken: result.csrfToken,
      operator: {
        id: result.principal.operatorId,
        displayName: result.principal.displayName,
        role: result.principal.role,
      },
    };
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
    return { operator, tenant };
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
