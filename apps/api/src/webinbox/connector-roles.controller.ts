import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import {
  CONNECTOR_ROLES,
  ConnectorSelector,
  connectorHasCapability,
  defaultCapability,
  type ConnectorCapabilityName,
} from '../connectors/connector-selector.js';
import { TenantConnectorLoader } from '../connectors/sync/tenant-connector-loader.js';
import type { ConnectorRole } from '../generated/prisma/client.js';
import { PrismaService } from '../persistence/prisma.service.js';
import {
  forbidden,
  invalidBody,
  notFound,
} from '../pipelines/pipeline-errors.js';
import { SessionGuard, type InboxRequest } from './session.guard.js';

export type ConnectorRoleStatus =
  'BOUND' | 'UNBOUND' | 'AMBIGUOUS' | 'UNAVAILABLE';

export interface ConnectorRoleItem {
  role: ConnectorRole;
  tenantConnectorId: string | null;
  connectorKey: string | null;
  status: ConnectorRoleStatus;
}

const PutBody = z
  .object({
    role: z.enum(['CATALOG', 'LEAD_SINK', 'ACTIONS']),
    tenantConnectorId: z.string().uuid().nullable(),
  })
  .strict();

/** Any write operation is enough to serve the ACTIONS role at bind time. */
const ACTION_CAPABILITIES: readonly ConnectorCapabilityName[] = [
  'createLead',
  'updateLead',
  'createBooking',
];

const capabilityMissing = (): BadRequestException =>
  new BadRequestException({
    code: 'CONNECTOR_CAPABILITY_MISSING',
    message: 'The connector does not offer what this role needs',
    i18nKey: 'errors.connectorCapabilityMissing',
  });
const connectorUnusable = (code: string): BadRequestException =>
  new BadRequestException({
    code,
    message: 'The connector is not usable',
    i18nKey: `errors.${code}`,
  });

/**
 * Which connector serves which purpose (ADR 059). OWNER/ADMIN only; the
 * tenant comes from the session. Audit rows carry ids and keys, never config.
 */
@Controller('api/v1/connectors/roles')
@UseGuards(SessionGuard)
export class ConnectorRolesController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly selector: ConnectorSelector,
    private readonly loader: TenantConnectorLoader,
  ) {}

  private manager(request: InboxRequest): {
    tenantId: string;
    operatorId: string;
  } {
    const principal = request.principal!;
    if (principal.role !== 'OWNER' && principal.role !== 'ADMIN')
      throw forbidden();
    return { tenantId: principal.tenantId, operatorId: principal.operatorId };
  }

  private async item(
    tenantId: string,
    role: ConnectorRole,
  ): Promise<ConnectorRoleItem> {
    const resolution = await this.selector.resolve(tenantId, role);
    if (resolution.kind === 'UNBOUND')
      return {
        role,
        tenantConnectorId: null,
        connectorKey: null,
        status: resolution.candidates.length > 1 ? 'AMBIGUOUS' : 'UNBOUND',
      };
    return {
      role,
      tenantConnectorId: resolution.row.id,
      connectorKey: resolution.row.connectorKey,
      status: resolution.kind === 'BOUND' ? 'BOUND' : 'UNAVAILABLE',
    };
  }

  @Get()
  async list(@Req() request: InboxRequest): Promise<{
    items: ConnectorRoleItem[];
  }> {
    const who = this.manager(request);
    const items: ConnectorRoleItem[] = [];
    for (const role of CONNECTOR_ROLES)
      items.push(await this.item(who.tenantId, role));
    return { items };
  }

  @Put()
  async put(
    @Req() request: InboxRequest,
    @Body() body: unknown,
  ): Promise<ConnectorRoleItem> {
    const who = this.manager(request);
    const parsed = PutBody.safeParse(body);
    if (!parsed.success) throw invalidBody();
    const { role, tenantConnectorId } = parsed.data;

    if (tenantConnectorId === null) {
      const previous = await this.prisma.tenantConnectorRole.findFirst({
        where: { tenantId: who.tenantId, role },
        include: { connector: { select: { connectorKey: true } } },
      });
      if (previous) {
        await this.prisma.tenantConnectorRole.deleteMany({
          where: { tenantId: who.tenantId, role },
        });
        await this.audit(
          who,
          'connector.role.unbound',
          previous.tenantConnectorId,
          {
            role,
            connectorKey: previous.connector.connectorKey,
          },
        );
      }
      return this.item(who.tenantId, role);
    }

    const row = await this.prisma.tenantConnector.findFirst({
      where: { id: tenantConnectorId, tenantId: who.tenantId },
    });
    if (!row) throw notFound();
    if (row.status !== 'ACTIVE')
      throw connectorUnusable('CONNECTOR_NOT_ACTIVE');
    let connector;
    try {
      connector = await this.loader.create(row);
    } catch {
      throw connectorUnusable('CONNECTOR_UNAVAILABLE');
    }
    const needed = defaultCapability(role);
    const capable = needed
      ? connectorHasCapability(connector, needed)
      : ACTION_CAPABILITIES.some((c) => connectorHasCapability(connector, c));
    if (!capable) throw capabilityMissing();

    await this.prisma.tenantConnectorRole.upsert({
      where: { tenantId_role: { tenantId: who.tenantId, role } },
      create: { tenantId: who.tenantId, role, tenantConnectorId: row.id },
      update: { tenantConnectorId: row.id },
    });
    await this.audit(who, 'connector.role.bound', row.id, {
      role,
      connectorKey: row.connectorKey,
    });
    return this.item(who.tenantId, role);
  }

  private async audit(
    who: { tenantId: string; operatorId: string },
    action: string,
    connectorId: string,
    summary: Record<string, string>,
  ): Promise<void> {
    await this.prisma.auditEvent.create({
      data: {
        tenantId: who.tenantId,
        actorType: 'OPERATOR',
        actorId: who.operatorId,
        action,
        entityType: 'tenant_connector',
        entityId: connectorId,
        safeInputSummary: summary,
      },
    });
  }
}
