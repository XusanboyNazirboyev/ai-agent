import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppEnvironment } from '../config/environment.js';
import { SessionService, type InboxPrincipal } from './session.service.js';

export const SESSION_COOKIE = 'ac_session';
export const CSRF_HEADER = 'x-csrf-token';

export interface InboxRequest {
  method: string;
  headers: Record<string, string | string[] | undefined>;
  principal?: InboxPrincipal;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function readCookie(
  header: string | string[] | undefined,
  name: string,
): string | undefined {
  const raw = Array.isArray(header) ? header.join(';') : header;
  if (!raw) return undefined;
  for (const part of raw.split(';')) {
    const index = part.indexOf('=');
    if (index > 0 && part.slice(0, index).trim() === name)
      return part.slice(index + 1).trim();
  }
  return undefined;
}

/**
 * Authenticates a web-inbox request from the httpOnly session cookie. Unsafe
 * methods additionally need the CSRF header (bound to the session) and, when
 * the browser sends one, an allowed Origin. Every refusal of authentication
 * is the same 401; the tenant always comes from the session row.
 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    private readonly sessions: SessionService,
    private readonly config: ConfigService<AppEnvironment, true>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<InboxRequest>();
    const token = readCookie(request.headers.cookie, SESSION_COOKIE);
    const resolved = token ? await this.sessions.resolve(token) : undefined;
    if (!resolved)
      throw new UnauthorizedException({
        code: 'UNAUTHENTICATED',
        message: 'Sign in required',
        i18nKey: 'errors.unauthenticated',
      });
    if (!SAFE_METHODS.has(request.method.toUpperCase())) {
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
    request.principal = {
      tenantId: resolved.tenantId,
      operatorId: resolved.operatorId,
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
