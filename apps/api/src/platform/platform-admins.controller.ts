import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import type { Prisma } from '../generated/prisma/client.js';
import { MfaService } from '../auth/mfa.service.js';
import { PrismaService } from '../persistence/prisma.service.js';
import {
  generateInviteToken,
  hashInviteToken,
  inviteExpiry,
} from '../team/invite-token.js';
import { normalizeEmail } from '../team/operator-invite.service.js';
import { recordPlatformAudit } from './platform-audit.js';
import {
  conflict,
  isUniqueViolation,
  notFound,
  parseBody,
} from './platform-http.js';
import {
  PlatformAccessLevel,
  PlatformSessionGuard,
  type PlatformRequest,
} from './platform-session.guard.js';
import { PlatformSessionService } from './platform-session.service.js';

const InviteAdmin = z.object({
  email: z.string().min(3).max(254),
  displayName: z.string().trim().min(1).max(160),
  role: z.enum(['PLATFORM_OWNER', 'PLATFORM_SUPPORT']),
});

/** Refuses to leave the platform without an active owner. */
export function lastOwnerViolation(
  target: { role: string; isActive: boolean },
  activeOwners: number,
): boolean {
  return (
    target.role === 'PLATFORM_OWNER' && target.isActive && activeOwners <= 1
  );
}

async function lockAdmins(tx: Prisma.TransactionClient): Promise<void> {
  await tx.$queryRaw`SELECT 1::int AS locked FROM (SELECT pg_advisory_xact_lock(hashtextextended(${'agentcore:platform-admins'}, 0))) AS lock_result`;
}

/** Platform admins (ADR 047 §4): PLATFORM_OWNER only, never the last owner. */
@Controller('api/v1/platform/admins')
@PlatformAccessLevel('owner')
@UseGuards(PlatformSessionGuard)
export class PlatformAdminsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: PlatformSessionService,
    private readonly mfa: MfaService,
  ) {}

  @Get()
  async list(): Promise<{ admins: unknown[] }> {
    const rows = await this.prisma.platformAdmin.findMany({
      orderBy: { createdAt: 'asc' },
      take: 200,
      select: {
        id: true,
        email: true,
        displayName: true,
        role: true,
        isActive: true,
        passwordHash: true,
        totpEnabledAt: true,
        inviteExpiresAt: true,
        createdAt: true,
      },
    });
    return {
      admins: rows.map(({ passwordHash, totpEnabledAt, ...row }) => ({
        ...row,
        mfaEnabled: totpEnabledAt !== null,
        invitePending: passwordHash === null,
      })),
    };
  }

  /**
   * Lost authenticator and recovery codes (ADR 048): an owner clears another
   * admin's second factor; that admin enrols again at the next sign-in. Audited.
   * Your own is reset by the server CLI, not here.
   */
  @Post(':id/mfa/reset')
  @HttpCode(204)
  async resetMfa(
    @Req() request: PlatformRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    if (id === request.platform!.adminId)
      throw conflict('CANNOT_RESET_OWN_MFA');
    const target = await this.prisma.platformAdmin.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!target) throw notFound();
    await this.mfa.reset(
      { kind: 'PLATFORM', adminId: id },
      request.platform!.adminId,
    );
    await this.sessions.revokeAll(id);
  }

  @Post()
  async invite(
    @Req() request: PlatformRequest,
    @Body() body: unknown,
  ): Promise<unknown> {
    const input = parseBody(InviteAdmin, body);
    const email = normalizeEmail(input.email);
    if (!email) throw conflict('INVALID_EMAIL');
    const token = generateInviteToken();
    const expiresAt = inviteExpiry(new Date());
    try {
      const admin = await this.prisma.$transaction(async (tx) => {
        const created = await tx.platformAdmin.create({
          data: {
            email,
            displayName: input.displayName,
            role: input.role,
            inviteTokenHash: hashInviteToken(token),
            inviteExpiresAt: expiresAt,
          },
        });
        await recordPlatformAudit(tx, {
          actorAdminId: request.platform!.adminId,
          action: 'admin.invited',
          entityType: 'platform_admin',
          entityId: created.id,
          summary: { role: created.role },
        });
        return created;
      });
      return {
        id: admin.id,
        email: admin.email,
        role: admin.role,
        expiresAt,
        token,
        path: `/console/invite/${token}`,
      };
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict('EMAIL_TAKEN');
      throw error;
    }
  }

  @Post(':id/deactivate')
  async deactivate(
    @Req() request: PlatformRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<{ id: string; isActive: boolean }> {
    const actor = request.platform!.adminId;
    if (actor === id)
      throw new ForbiddenException({
        code: 'SELF_EDIT',
        message: 'Not allowed',
        i18nKey: 'platform.errors.SELF_EDIT',
      });
    await this.prisma.$transaction(async (tx) => {
      await lockAdmins(tx);
      const target = await tx.platformAdmin.findUnique({ where: { id } });
      if (!target) throw notFound();
      const activeOwners = await tx.platformAdmin.count({
        where: { role: 'PLATFORM_OWNER', isActive: true },
      });
      if (lastOwnerViolation(target, activeOwners))
        throw new ForbiddenException({
          code: 'LAST_OWNER',
          message: 'Not allowed',
          i18nKey: 'platform.errors.LAST_OWNER',
        });
      await tx.platformAdmin.update({
        where: { id },
        data: { isActive: false, inviteTokenHash: null, inviteExpiresAt: null },
      });
      await recordPlatformAudit(tx, {
        actorAdminId: actor,
        action: 'admin.deactivated',
        entityType: 'platform_admin',
        entityId: id,
        summary: { role: target.role },
      });
    });
    await this.sessions.revokeAll(id);
    return { id, isActive: false };
  }
}
