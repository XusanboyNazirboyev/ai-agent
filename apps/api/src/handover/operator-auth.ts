import { createHash, randomBytes } from 'node:crypto';
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaService } from '../persistence/prisma.service.js';

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
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<{
      headers: Record<string, string | undefined>;
      operator?: AuthenticatedOperator;
    }>();
    const header = request.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!token.startsWith(PREFIX) || token.length > 200) throw this.reject();
    const row = await this.prisma.operatorApiToken.findFirst({
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
    request.operator = { tenantId: row.tenantId, operatorId: row.operatorId };
    // Best effort: a failed bookkeeping write must not block the operator.
    await this.prisma.operatorApiToken
      .updateMany({ where: { id: row.id }, data: { lastUsedAt: new Date() } })
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
