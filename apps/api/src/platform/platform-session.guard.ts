import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import type { AppEnvironment } from '../config/environment.js';
import { CSRF_HEADER, readCookie } from '../webinbox/session.guard.js';
import {
  PlatformSessionService,
  type PlatformPrincipal,
} from './platform-session.service.js';

export const PLATFORM_COOKIE = 'ac_platform';
export const PLATFORM_CSRF_COOKIE = 'ac_platform_csrf';

export interface PlatformRequest {
  method: string;
  headers: Record<string, string | string[] | undefined>;
  platform?: PlatformPrincipal;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Route metadata: which platform roles may call it. */
export const PLATFORM_ROLES = 'platform:roles';
export type PlatformAccess = 'read' | 'write' | 'owner' | 'self';

/**
 * `read`: any admin (default for safe methods). `write`: PLATFORM_OWNER
 * (default for unsafe methods). `owner`: PLATFORM_OWNER even for reads.
 * `self`: any admin, also for unsafe methods (logout).
 */
export const PlatformAccessLevel = (
  level: PlatformAccess,
): MethodDecorator & ClassDecorator => SetMetadata(PLATFORM_ROLES, level);

/**
 * Authenticates a platform console request from `ac_platform` only (ADR 047
 * §1): a tenant `ac_session` cookie is never read here. Unsafe methods need
 * the CSRF header bound to the session and an allowed Origin. PLATFORM_SUPPORT
 * is read-only, enforced here for every route.
 */
@Injectable()
export class PlatformSessionGuard implements CanActivate {
  constructor(
    private readonly sessions: PlatformSessionService,
    private readonly config: ConfigService<AppEnvironment, true>,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<PlatformRequest>();
    const token = readCookie(request.headers.cookie, PLATFORM_COOKIE);
    const resolved = token ? await this.sessions.resolve(token) : undefined;
    if (!resolved)
      throw new UnauthorizedException({
        code: 'UNAUTHENTICATED',
        message: 'Sign in required',
        i18nKey: 'errors.unauthenticated',
      });
    const safe = SAFE_METHODS.has(request.method.toUpperCase());
    if (!safe) {
      const origin = request.headers.origin;
      const allowed = this.config.get('WEB_ORIGINS', { infer: true });
      if (typeof origin === 'string' && !allowed.includes(origin))
        throw this.forbidden('BAD_ORIGIN');
      const presented = request.headers[CSRF_HEADER];
      if (
        !this.sessions.csrfMatches(
          resolved.csrfHash,
          typeof presented === 'string' ? presented : undefined,
        )
      )
        throw this.forbidden('CSRF');
    }
    const level =
      this.reflector.getAllAndOverride<PlatformAccess | undefined>(
        PLATFORM_ROLES,
        [context.getHandler(), context.getClass()],
      ) ?? (safe ? 'read' : 'write');
    const needsOwner = level === 'owner' || (!safe && level !== 'self');
    if (needsOwner && resolved.role !== 'PLATFORM_OWNER')
      throw this.forbidden('FORBIDDEN');
    request.platform = {
      adminId: resolved.adminId,
      role: resolved.role,
      sessionId: resolved.sessionId,
    };
    return true;
  }

  private forbidden(code: string): ForbiddenException {
    return new ForbiddenException({
      code,
      message: 'Request refused',
      i18nKey: 'errors.forbidden',
    });
  }
}
