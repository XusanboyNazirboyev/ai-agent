import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpException,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { PrismaService } from '../persistence/prisma.service.js';
import {
  InviteError,
  lockTenantTeam,
  OperatorInviteService,
  type CreatedInvite,
  type PendingInvite,
} from '../team/operator-invite.service.js';
import {
  canManageTeam,
  checkInvite,
  checkOperatorChange,
  TEAM_ROLES,
  type TeamRole,
  type TeamRuleViolation,
} from '../team/team-rules.js';
import { SessionGuard, type InboxRequest } from './session.guard.js';

const Role = z.enum(TEAM_ROLES as [TeamRole, ...TeamRole[]]);
const InviteBody = z.object({ email: z.string().min(3).max(254), role: Role });
const PatchBody = z
  .object({ role: Role.optional(), isActive: z.boolean().optional() })
  .refine((body) => body.role !== undefined || body.isActive !== undefined);

export interface TeamMember {
  id: string;
  displayName: string;
  role: TeamRole;
  isActive: boolean;
  email: string | null;
  createdAt: Date;
}

function invalidBody(): BadRequestException {
  return new BadRequestException({
    code: 'INVALID_BODY',
    message: 'Invalid body',
    i18nKey: 'errors.invalidBody',
  });
}

function violation(code: TeamRuleViolation): ForbiddenException {
  return new ForbiddenException({
    code,
    message: 'Not allowed',
    i18nKey: code === 'FORBIDDEN' ? 'errors.forbidden' : `team.errors.${code}`,
  });
}

export function inviteHttpError(error: unknown): unknown {
  if (!(error instanceof InviteError)) return error;
  const body = {
    code: error.code,
    message: 'Invite refused',
    i18nKey: `team.errors.${error.code}`,
  };
  switch (error.code) {
    case 'INVITE_INVALID':
      return new NotFoundException(body);
    case 'TENANT_SUSPENDED':
      return new ForbiddenException(body);
    case 'NOT_FOUND':
      return new NotFoundException(body);
    default:
      return new ConflictException(body);
  }
}

/**
 * Tenant Team page (ADR 047 §5), OWNER and ADMIN only. Rules live in
 * `team-rules.ts`; the seat limit (`maxOperators`) in the invite service.
 * Every change is a tenant audit event.
 */
@Controller('api/v1/team')
@UseGuards(SessionGuard)
export class TeamController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly invites: OperatorInviteService,
  ) {}

  private manager(request: InboxRequest): {
    tenantId: string;
    operatorId: string;
    role: TeamRole;
  } {
    const principal = request.principal!;
    if (!canManageTeam(principal.role)) throw violation('FORBIDDEN');
    return principal;
  }

  @Get()
  async list(@Req() request: InboxRequest): Promise<{
    operators: TeamMember[];
    invites: PendingInvite[];
    limits: { maxOperators: number | null; seatsUsed: number };
  }> {
    const { tenantId } = this.manager(request);
    const now = new Date();
    const rows = await this.prisma.operator.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'asc' },
      take: 500,
      select: {
        id: true,
        displayName: true,
        role: true,
        isActive: true,
        createdAt: true,
        credentials: { select: { email: true }, take: 1 },
      },
    });
    return {
      operators: rows.map((row) => ({
        id: row.id,
        displayName: row.displayName,
        role: row.role,
        isActive: row.isActive,
        email: row.credentials[0]?.email ?? null,
        createdAt: row.createdAt,
      })),
      invites: await this.invites.listPending(tenantId, now),
      limits: {
        maxOperators: (await this.invites.seatLimit(tenantId)) ?? null,
        seatsUsed: await this.invites.seatsUsed(tenantId, now, true),
      },
    };
  }

  @Post('invites')
  async invite(
    @Req() request: InboxRequest,
    @Body() body: unknown,
  ): Promise<Omit<CreatedInvite, 'token'> & { token: string; path: string }> {
    const actor = this.manager(request);
    const parsed = InviteBody.safeParse(body);
    if (!parsed.success) throw invalidBody();
    const refused = checkInvite(actor.role, parsed.data.role);
    if (refused) throw violation(refused);
    let created: CreatedInvite;
    try {
      created = await this.invites.create({
        tenantId: actor.tenantId,
        email: parsed.data.email,
        role: parsed.data.role,
        createdByOperatorId: actor.operatorId,
      });
    } catch (error) {
      throw inviteHttpError(error);
    }
    await this.audit(
      actor,
      'team.invite_created',
      'operator_invite',
      created.id,
      {
        role: created.role,
      },
    );
    return { ...created, path: `/invite/${created.token}` };
  }

  @Delete('invites/:id')
  @HttpCode(204)
  async revoke(
    @Req() request: InboxRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    const actor = this.manager(request);
    const invite = await this.invites.findOpen(actor.tenantId, id);
    if (!invite)
      throw new NotFoundException({
        code: 'NOT_FOUND',
        message: 'Not found',
        i18nKey: 'errors.notFound',
      });
    const refused = checkInvite(actor.role, invite.role);
    if (refused) throw violation(refused);
    if (await this.invites.revoke(actor.tenantId, id))
      await this.audit(actor, 'team.invite_revoked', 'operator_invite', id, {
        role: invite.role,
      });
  }

  @Patch('operators/:id')
  async update(
    @Req() request: InboxRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: unknown,
  ): Promise<TeamMember> {
    const actor = this.manager(request);
    const parsed = PatchBody.safeParse(body);
    if (!parsed.success) throw invalidBody();
    const change = parsed.data;
    const now = new Date();
    const result = await this.prisma.$transaction(async (tx) => {
      await lockTenantTeam(tx, actor.tenantId);
      const target = await tx.operator.findFirst({
        where: { tenantId: actor.tenantId, id },
        select: { id: true, role: true, isActive: true },
      });
      if (!target) return 'NOT_FOUND' as const;
      const activeOwners = await tx.operator.count({
        where: { tenantId: actor.tenantId, role: 'OWNER', isActive: true },
      });
      const refused = checkOperatorChange({
        actor: { id: actor.operatorId, role: actor.role },
        target,
        change,
        activeOwners,
      });
      if (refused) return refused;
      if (change.isActive === true && !target.isActive) {
        const limit = await this.invites.seatLimit(actor.tenantId, tx);
        if (
          limit !== undefined &&
          (await this.invites.seatsUsed(actor.tenantId, now, false, tx)) >=
            limit
        )
          return 'SEATS_EXHAUSTED' as const;
      }
      await tx.operator.updateMany({
        where: { tenantId: actor.tenantId, id },
        data: {
          ...(change.role !== undefined ? { role: change.role } : {}),
          ...(change.isActive !== undefined
            ? { isActive: change.isActive }
            : {}),
        },
      });
      let clearedLeadOwners = 0;
      if (change.isActive === false) {
        await tx.operatorSession.updateMany({
          where: { tenantId: actor.tenantId, operatorId: id, revokedAt: null },
          data: { revokedAt: now },
        });
        // ADR 057: a deactivated operator no longer owns leads.
        clearedLeadOwners = (
          await tx.lead.updateMany({
            where: { tenantId: actor.tenantId, ownerOperatorId: id },
            data: { ownerOperatorId: null },
          })
        ).count;
      }
      await tx.auditEvent.create({
        data: {
          tenantId: actor.tenantId,
          actorType: 'OPERATOR',
          actorId: actor.operatorId,
          action: 'team.operator_updated',
          entityType: 'operator',
          entityId: id,
          safeInputSummary: {
            fromRole: target.role,
            toRole: change.role ?? target.role,
            fromActive: target.isActive,
            toActive: change.isActive ?? target.isActive,
          },
        },
      });
      if (clearedLeadOwners > 0)
        await tx.auditEvent.create({
          data: {
            tenantId: actor.tenantId,
            actorType: 'OPERATOR',
            actorId: actor.operatorId,
            action: 'lead.owner_cleared',
            entityType: 'operator',
            entityId: id,
            safeInputSummary: { leads: String(clearedLeadOwners) },
          },
        });
      return 'OK' as const;
    });
    if (result === 'NOT_FOUND')
      throw new NotFoundException({
        code: 'NOT_FOUND',
        message: 'Not found',
        i18nKey: 'errors.notFound',
      });
    if (result === 'SEATS_EXHAUSTED')
      throw new HttpException(
        {
          code: 'SEATS_EXHAUSTED',
          message: 'Plan limit reached',
          i18nKey: 'team.errors.SEATS_EXHAUSTED',
        },
        409,
      );
    if (result !== 'OK') throw violation(result);
    const row = await this.prisma.operator.findFirstOrThrow({
      where: { tenantId: actor.tenantId, id },
      select: {
        id: true,
        displayName: true,
        role: true,
        isActive: true,
        createdAt: true,
        credentials: { select: { email: true }, take: 1 },
      },
    });
    return {
      id: row.id,
      displayName: row.displayName,
      role: row.role,
      isActive: row.isActive,
      email: row.credentials[0]?.email ?? null,
      createdAt: row.createdAt,
    };
  }

  private async audit(
    actor: { tenantId: string; operatorId: string },
    action: string,
    entityType: string,
    entityId: string,
    summary: Record<string, string>,
  ): Promise<void> {
    await this.prisma.auditEvent.create({
      data: {
        tenantId: actor.tenantId,
        actorType: 'OPERATOR',
        actorId: actor.operatorId,
        action,
        entityType,
        entityId,
        safeInputSummary: summary,
      },
    });
  }
}
