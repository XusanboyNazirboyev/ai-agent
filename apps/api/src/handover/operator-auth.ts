import { createHash, randomBytes } from 'node:crypto';
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import type { PrismaClient } from '../generated/prisma/client.js';
import { enrichLogContext } from '../observability/log-context.js';
import { PrivilegedDatabase } from '../persistence/privileged-database.js';
import { PrismaService } from '../persistence/prisma.service.js';
import { setTenant } from '../persistence/tenant-context.js';

export interface AuthenticatedOperator {
  readonly tenantId: string;
  readonly operatorId: string;
}

const PREFIX = 'acop_';

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** A new random credential; show it once, store only its hash. */
export function newOperatorToken(): string {
  return `${PREFIX}${randomBytes(32).toString('base64url')}`;
}

/**
 * Authenticates an operator API request: `Authorization: Bearer acop_...`.
 * The token resolves to one operator of one tenant; the tenant is never
 * taken from the request. Revoked tokens and inactive or viewer-only
 * operators are refused, and every refusal is the same 401 (no oracle).
 */
@Injectable()
export class OperatorTokenGuard implements CanActivate {
  /**
   * The token is looked up before any tenant is known, so on the privileged
   * connection (RLS plan S5); the request then runs under the token's tenant.
   */
  private readonly db: PrismaClient;

  constructor(
    private readonly prisma: PrismaService,
    // Optional only so specs can build the guard by hand; Nest always
    // provides it, next to PrismaService, from PersistenceModule.
    @Optional() privileged?: PrivilegedDatabase,
  ) {
    this.db = privileged?.db ?? prisma;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<{
      headers: Record<string, string | undefined>;
      operator?: AuthenticatedOperator;
    }>();
    const header = request.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!token.startsWith(PREFIX) || token.length > 200) throw this.reject();
    const row = await this.db.operatorApiToken.findFirst({
      where: {
        tokenHash: hashToken(token),
        revokedAt: null,
        operator: {
          isActive: true,
          role: { in: ['OWNER', 'ADMIN', 'OPERATOR'] },
        },
      },
      select: { id: true, tenantId: true, operatorId: true },
    });
    if (!row) throw this.reject();
    enrichLogContext({ tenantId: row.tenantId });
    // RLS (ADR 050): the request's queries run for this tenant from here on.
    setTenant(row.tenantId);
    request.operator = { tenantId: row.tenantId, operatorId: row.operatorId };
    // Best effort: a failed bookkeeping write must not block the operator.
    await this.prisma.operatorApiToken
      .updateMany({
        where: { tenantId: row.tenantId, id: row.id },
        data: { lastUsedAt: new Date() },
      })
      .catch(() => undefined);
    return true;
  }

  private reject(): UnauthorizedException {
    return new UnauthorizedException({
      code: 'UNAUTHENTICATED',
      message: 'Invalid or revoked credential',
      i18nKey: 'errors.unauthenticated',
    });
  }
}
