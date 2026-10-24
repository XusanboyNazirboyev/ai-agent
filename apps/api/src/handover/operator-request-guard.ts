import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { SessionGuard, type InboxRequest } from '../webinbox/session.guard.js';
import {
  OperatorTokenGuard,
  type AuthenticatedOperator,
} from './operator-auth.js';

/**
 * Operator command authentication: an API token (`Authorization: Bearer`)
 * for integrations, or the web-inbox session cookie (with CSRF and Origin
 * checks) for the browser. Either way the tenant and operator come from the
 * credential, never from the request, and the role check stays in the
 * handover service.
 */
@Injectable()
export class OperatorRequestGuard implements CanActivate {
  constructor(
    private readonly tokens: OperatorTokenGuard,
    private readonly sessions: SessionGuard,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<InboxRequest & { operator?: AuthenticatedOperator }>();
    const authorization = request.headers.authorization;
    if (
      typeof authorization === 'string' &&
      authorization.startsWith('Bearer ')
    )
      return this.tokens.canActivate(context);
    await this.sessions.canActivate(context);
    request.operator = {
      tenantId: request.principal!.tenantId,
      operatorId: request.principal!.operatorId,
    };
    return true;
  }
}
