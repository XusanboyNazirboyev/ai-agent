import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpException,
  Inject,
  Logger,
  NotFoundException,
  Optional,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import {
  parseWebhookUrl,
  type Bitrix24Transport,
} from '../connectors/bitrix24/bitrix24-client.js';
import { Bitrix24Connector } from '../connectors/bitrix24/bitrix24-connector.js';
import {
  ConnectorError,
  ConnectorUnavailableError,
} from '../connectors/interfaces/errors.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../persistence/prisma.service.js';
import { ConnectorSecretStore } from '../secrets/connector-secret-store.js';
import { SessionGuard, type InboxRequest } from './session.guard.js';

/** Test seam for the Bitrix24 check (a fake portal in tests and e2e). */
export const BITRIX24_CONNECT_TRANSPORT = Symbol('BITRIX24_CONNECT_TRANSPORT');

const WEBHOOK_REF = 'store:bitrix24_webhook_url';
const ConnectBody = z.object({ webhookUrl: z.string().trim().min(1).max(500) });

const REFUSAL: Record<string, { status: number; i18nKey: string }> = {
  INVALID_BODY: { status: 400, i18nKey: 'errors.invalidBody' },
  INVALID_WEBHOOK_URL: { status: 400, i18nKey: 'errors.invalidWebhookUrl' },
  CRM_UNREACHABLE: { status: 502, i18nKey: 'errors.crmUnreachable' },
  CRM_REJECTED: { status: 502, i18nKey: 'errors.crmRejected' },
  LEADS_DISABLED: { status: 409, i18nKey: 'errors.leadsDisabled' },
  SECRETS_NOT_CONFIGURED: {
    status: 503,
    i18nKey: 'errors.secretsNotConfigured',
  },
  RATE_LIMITED: { status: 429, i18nKey: 'errors.rateLimited' },
};

function refuse(code: keyof typeof REFUSAL): HttpException {
  const spec = REFUSAL[code];
  return new HttpException(
    { code, message: code, i18nKey: spec.i18nKey },
    spec.status,
  );
}

export interface ConnectorSummary {
  id: string;
  connectorKey: string;
  status: 'ACTIVE' | 'DISABLED' | 'ERROR';
  /** A credential is saved for it (never the value itself). */
  configured: boolean;
}

export interface ConnectorList {
  items: ConnectorSummary[];
  secretsConfigured: boolean;
}

/**
 * Connecting a CRM from the web (ADR 032, slice 1: Bitrix24 as a lead sink).
 * OWNER/ADMIN only, CSRF-protected by the session guard, at most 10 calls a
 * minute per operator, every change audited without the URL. The incoming
 * webhook URL is a secret: it is checked against the portal, stored
 * encrypted and never part of a response, a log line or an audit row.
 */
@Controller('api/v1/connectors')
@UseGuards(SessionGuard)
export class ConnectorsController {
  private readonly logger = new Logger(ConnectorsController.name);
  private readonly calls = new Map<string, number[]>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly secrets: ConnectorSecretStore,
    @Optional()
    @Inject(BITRIX24_CONNECT_TRANSPORT)
    private readonly transport?: Bitrix24Transport | null,
  ) {}

  private admit(request: InboxRequest): {
    tenantId: string;
    operatorId: string;
  } {
    const principal = request.principal!;
    if (principal.role !== 'OWNER' && principal.role !== 'ADMIN')
      throw new ForbiddenException({
        code: 'FORBIDDEN',
        message: 'Not allowed',
        i18nKey: 'errors.forbidden',
      });
    const now = Date.now();
    const recent = (this.calls.get(principal.operatorId) ?? []).filter(
      (at) => now - at < 60_000,
    );
    if (recent.length >= 10) throw refuse('RATE_LIMITED');
    recent.push(now);
    this.calls.set(principal.operatorId, recent);
    return { tenantId: principal.tenantId, operatorId: principal.operatorId };
  }

  private async audit(
    who: { tenantId: string; operatorId: string },
    action: string,
    id: string,
    summary: Record<string, string | boolean> = {},
  ): Promise<void> {
    await this.prisma.auditEvent.create({
      data: {
        tenantId: who.tenantId,
        actorType: 'OPERATOR',
        actorId: who.operatorId,
        action,
        entityType: 'tenant_connector',
        entityId: id,
        safeInputSummary: summary,
      },
    });
  }

  @Get()
  async list(@Req() request: InboxRequest): Promise<ConnectorList> {
    const who = this.admit(request);
    const rows = await this.prisma.tenantConnector.findMany({
      where: { tenantId: who.tenantId },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        connectorKey: true,
        status: true,
        secrets: { select: { purpose: true } },
      },
    });
    return {
      items: rows.map((row) => ({
        id: row.id,
        connectorKey: row.connectorKey,
        status: row.status,
        configured: row.secrets.length > 0,
      })),
      secretsConfigured: this.secrets.configured,
    };
  }

  /**
   * Checks the URL's shape, then asks the portal for its CRM mode through
   * the connector's own allow-listed client; only a portal in classic mode
   * (leads available) is saved. The mock connector stops creating leads, so
   * Bitrix24 becomes the lead sink (DEF-015 routing).
   */
  @Post('bitrix24')
  async connectBitrix24(
    @Req() request: InboxRequest,
    @Body() body: unknown,
  ): Promise<ConnectorSummary> {
    const who = this.admit(request);
    if (!this.secrets.configured) throw refuse('SECRETS_NOT_CONFIGURED');
    const parsed = ConnectBody.safeParse(body);
    if (!parsed.success) throw refuse('INVALID_BODY');
    let webhookUrl: string;
    try {
      webhookUrl = parseWebhookUrl(parsed.data.webhookUrl).href;
    } catch {
      throw refuse('INVALID_WEBHOOK_URL');
    }
    await this.check(who.tenantId, webhookUrl);

    const existing = await this.prisma.tenantConnector.findUnique({
      where: {
        tenantId_connectorKey: {
          tenantId: who.tenantId,
          connectorKey: 'bitrix24',
        },
      },
      select: { id: true, config: true },
    });
    const config = {
      ...(isObject(existing?.config) ? existing.config : {}),
      webhookSecretRef: WEBHOOK_REF,
    } as Prisma.InputJsonObject;
    const row = existing
      ? await this.prisma.tenantConnector.update({
          where: { id: existing.id },
          data: { status: 'ACTIVE', config },
          select: { id: true },
        })
      : await this.prisma.tenantConnector.create({
          data: {
            tenantId: who.tenantId,
            connectorKey: 'bitrix24',
            status: 'ACTIVE',
            config,
          },
          select: { id: true },
        });
    await this.secrets.put(
      { tenantId: who.tenantId, tenantConnectorId: row.id },
      'bitrix24_webhook_url',
      webhookUrl,
    );
    await this.stopMockLeads(who.tenantId);
    await this.audit(
      who,
      existing
        ? 'connector.bitrix24_reconnected'
        : 'connector.bitrix24_connected',
      row.id,
      { connectorKey: 'bitrix24' },
    );
    return {
      id: row.id,
      connectorKey: 'bitrix24',
      status: 'ACTIVE',
      configured: true,
    };
  }

  @Post(':id/disable')
  async disable(
    @Req() request: InboxRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<ConnectorSummary> {
    const who = this.admit(request);
    const row = await this.owned(who.tenantId, id);
    await this.prisma.tenantConnector.update({
      where: { id: row.id },
      data: { status: 'DISABLED' },
    });
    await this.audit(who, 'connector.disabled', row.id, {
      connectorKey: row.connectorKey,
    });
    return {
      id: row.id,
      connectorKey: row.connectorKey,
      status: 'DISABLED',
      configured: await this.hasSecret(who.tenantId, row.id),
    };
  }

  /** Switches the connector off and deletes its saved credential; the row stays. */
  @Delete(':id')
  @HttpCode(204)
  async disconnect(
    @Req() request: InboxRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    const who = this.admit(request);
    const row = await this.owned(who.tenantId, id);
    await this.prisma.tenantConnector.update({
      where: { id: row.id },
      data: { status: 'DISABLED' },
    });
    await this.secrets.deleteAll({
      tenantId: who.tenantId,
      tenantConnectorId: row.id,
    });
    await this.audit(who, 'connector.disconnected', row.id, {
      connectorKey: row.connectorKey,
    });
  }

  private async owned(
    tenantId: string,
    id: string,
  ): Promise<{ id: string; connectorKey: string }> {
    const row = await this.prisma.tenantConnector.findFirst({
      where: { id, tenantId },
      select: { id: true, connectorKey: true },
    });
    if (!row)
      throw new NotFoundException({
        code: 'NOT_FOUND',
        message: 'Not found',
        i18nKey: 'errors.notFound',
      });
    return row;
  }

  private async hasSecret(tenantId: string, id: string): Promise<boolean> {
    return (
      (await this.prisma.connectorSecret.count({
        where: { tenantId, tenantConnectorId: id },
      })) > 0
    );
  }

  /** The portal's CRM mode through the connector's allow-listed client. */
  private async check(tenantId: string, webhookUrl: string): Promise<void> {
    try {
      const probe = new Bitrix24Connector(
        { tenantId, connectorKey: 'bitrix24' },
        { webhookSecretRef: WEBHOOK_REF },
        {
          resolveSecret: {
            resolve: (ref): string | undefined =>
              ref === WEBHOOK_REF ? webhookUrl : undefined,
          },
          ...(this.transport
            ? {
                client: {
                  transport: this.transport,
                  minIntervalMs: 0,
                  maxRateRetries: 0,
                },
              }
            : {}),
        },
      );
      await probe.validateConfiguration();
    } catch (error) {
      const code = error instanceof ConnectorError ? error.code : 'UNEXPECTED';
      // The code only: a connector error message never carries the URL, but
      // nothing here depends on that.
      this.logger.warn(
        JSON.stringify({ event: 'connector.bitrix24_check_failed', code }),
      );
      if (code === 'BITRIX24_LEADS_DISABLED') throw refuse('LEADS_DISABLED');
      if (code === 'BITRIX24_INVALID_WEBHOOK_URL')
        throw refuse('INVALID_WEBHOOK_URL');
      if (error instanceof ConnectorUnavailableError)
        throw refuse('CRM_UNREACHABLE');
      throw refuse('CRM_REJECTED');
    }
  }

  /** The fictional mock catalog must not keep taking the leads (DEF-015). */
  private async stopMockLeads(tenantId: string): Promise<void> {
    const mock = await this.prisma.tenantConnector.findUnique({
      where: { tenantId_connectorKey: { tenantId, connectorKey: 'mock' } },
      select: { id: true, config: true },
    });
    if (!mock) return;
    const config = isObject(mock.config) ? mock.config : {};
    if (config.createLead === false) return;
    await this.prisma.tenantConnector.update({
      where: { id: mock.id },
      data: {
        config: { ...config, createLead: false } as Prisma.InputJsonObject,
      },
    });
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
