import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpException,
  Inject,
  Logger,
  Optional,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { AmocrmSubdomainSchema } from '@agentcore/shared';
import type { AmocrmTransport } from '../connectors/amocrm/amocrm-client.js';
import { AmocrmConnector } from '../connectors/amocrm/amocrm-connector.js';
import {
  ConnectorError,
  ConnectorErrorCategory,
  ConnectorUnauthorizedError,
  ConnectorUnavailableError,
} from '../connectors/interfaces/errors.js';
import { TenantConnectorLoader } from '../connectors/sync/tenant-connector-loader.js';
import type { Prisma } from '../generated/prisma/client.js';
import { requeueLocalLeads } from '../leads/lead-requeue.js';
import { PrismaService } from '../persistence/prisma.service.js';
import { ConnectorSecretStore } from '../secrets/connector-secret-store.js';
import { SessionGuard, type InboxRequest } from './session.guard.js';

/** Test seam for the amoCRM check (a fake account in tests). */
export const AMOCRM_CONNECT_TRANSPORT = Symbol('AMOCRM_CONNECT_TRANSPORT');

const TOKEN_REF = 'store:amocrm_token';
const ConnectBody = z
  .object({
    subdomain: z.string().trim().toLowerCase().pipe(AmocrmSubdomainSchema),
    token: z.string().trim().min(10).max(4000),
  })
  .strict();
const PipelineBody = z
  .object({ pipelineId: z.number().int().positive() })
  .strict();

const REFUSAL: Record<string, { status: number; i18nKey: string }> = {
  INVALID_BODY: { status: 400, i18nKey: 'amocrm.err.invalid' },
  TOKEN_INVALID: { status: 400, i18nKey: 'amocrm.err.token' },
  CRM_UNREACHABLE: { status: 502, i18nKey: 'errors.crmUnreachable' },
  CRM_REJECTED: { status: 502, i18nKey: 'amocrm.err.rejected' },
  NOT_FOUND: { status: 404, i18nKey: 'errors.notFound' },
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

export interface AmocrmPipelineView {
  pipelines: Array<{ id: number; name: string; isMain: boolean }>;
  /** The pipeline new leads go to; null until one is chosen. */
  pipelineId: number | null;
}

/**
 * Connecting amoCRM from the web (ADR 081), like Bitrix24 (ADR 032):
 * OWNER/ADMIN only, CSRF by the session guard, at most 10 changes a minute per
 * operator, every change audited without the token. The long-lived token is
 * checked with one read of the account, stored encrypted and never part of a
 * response, a log line or an audit row.
 */
@Controller('api/v1/connectors')
@UseGuards(SessionGuard)
export class AmocrmController {
  private readonly logger = new Logger(AmocrmController.name);
  private readonly calls = new Map<string, number[]>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly secrets: ConnectorSecretStore,
    private readonly loader: TenantConnectorLoader,
    @Optional()
    @Inject(AMOCRM_CONNECT_TRANSPORT)
    private readonly transport?: AmocrmTransport | null,
  ) {}

  private manager(request: InboxRequest): {
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
    return { tenantId: principal.tenantId, operatorId: principal.operatorId };
  }

  private admit(request: InboxRequest): {
    tenantId: string;
    operatorId: string;
  } {
    const who = this.manager(request);
    const now = Date.now();
    const recent = (this.calls.get(who.operatorId) ?? []).filter(
      (at) => now - at < 60_000,
    );
    if (recent.length >= 10) throw refuse('RATE_LIMITED');
    recent.push(now);
    this.calls.set(who.operatorId, recent);
    return who;
  }

  private async audit(
    who: { tenantId: string; operatorId: string },
    action: string,
    id: string,
    summary: Record<string, string | number | boolean>,
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

  @Post('amocrm')
  async connect(
    @Req() request: InboxRequest,
    @Body() body: unknown,
  ): Promise<{
    id: string;
    connectorKey: 'amocrm';
    status: 'ACTIVE';
    configured: true;
  }> {
    const who = this.admit(request);
    if (!this.secrets.configured) throw refuse('SECRETS_NOT_CONFIGURED');
    const parsed = ConnectBody.safeParse(body);
    if (!parsed.success) throw refuse('INVALID_BODY');
    const { subdomain, token } = parsed.data;
    await this.check(who.tenantId, subdomain, token);

    const existing = await this.prisma.tenantConnector.findUnique({
      where: {
        tenantId_connectorKey: {
          tenantId: who.tenantId,
          connectorKey: 'amocrm',
        },
      },
      select: { id: true, config: true },
    });
    const previous = isObject(existing?.config) ? existing.config : {};
    // A different account has other pipelines: the old choice is dropped.
    const sameAccount = previous.subdomain === subdomain;
    const config = {
      ...(sameAccount ? previous : {}),
      subdomain,
      tokenSecretRef: TOKEN_REF,
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
            connectorKey: 'amocrm',
            status: 'ACTIVE',
            config,
          },
          select: { id: true },
        });
    await this.secrets.put(
      { tenantId: who.tenantId, tenantConnectorId: row.id },
      'amocrm_token',
      token,
    );
    if (existing && !sameAccount)
      await this.prisma.crmStageMapping.deleteMany({
        where: { tenantId: who.tenantId, tenantConnectorId: row.id },
      });
    await this.stopOtherLeadSinks(who.tenantId);
    // Leads kept local while no CRM was connected go to the new one (ADR 037).
    const requeued = await requeueLocalLeads(
      this.prisma,
      who.tenantId,
      `crm-connected:${row.id}:${Date.now()}`,
    );
    await this.audit(
      who,
      existing ? 'connector.amocrm_reconnected' : 'connector.amocrm_connected',
      row.id,
      { connectorKey: 'amocrm', requeuedLeads: requeued },
    );
    return {
      id: row.id,
      connectorKey: 'amocrm',
      status: 'ACTIVE',
      configured: true,
    };
  }

  @Get(':id/amocrm/pipelines')
  async pipelines(
    @Req() request: InboxRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<AmocrmPipelineView> {
    const who = this.manager(request);
    const { connector, pipelineId } = await this.load(who.tenantId, id);
    try {
      const pipelines = await connector.listPipelines();
      return {
        pipelines: pipelines.map(({ id: pid, name, isMain }) => ({
          id: pid,
          name,
          isMain,
        })),
        pipelineId,
      };
    } catch (error) {
      throw this.failure('pipelines', error);
    }
  }

  @Put(':id/amocrm/pipeline')
  async choosePipeline(
    @Req() request: InboxRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: unknown,
  ): Promise<AmocrmPipelineView> {
    const who = this.admit(request);
    const parsed = PipelineBody.safeParse(body);
    if (!parsed.success) throw refuse('INVALID_BODY');
    const {
      connector,
      config,
      pipelineId: before,
    } = await this.load(who.tenantId, id);
    let pipelines;
    try {
      pipelines = await connector.listPipelines();
    } catch (error) {
      throw this.failure('pipeline', error);
    }
    if (!pipelines.some((p) => p.id === parsed.data.pipelineId))
      throw refuse('INVALID_BODY');
    await this.prisma.$transaction(async (tx) => {
      await tx.tenantConnector.update({
        where: { id },
        data: {
          config: {
            ...config,
            pipelineId: parsed.data.pipelineId,
          } as Prisma.InputJsonObject,
        },
      });
      // Stage mappings belong to the pipeline they were made for.
      if (before !== parsed.data.pipelineId)
        await tx.crmStageMapping.deleteMany({
          where: { tenantId: who.tenantId, tenantConnectorId: id },
        });
      await tx.auditEvent.create({
        data: {
          tenantId: who.tenantId,
          actorType: 'OPERATOR',
          actorId: who.operatorId,
          action: 'connector.amocrm_pipeline_chosen',
          entityType: 'tenant_connector',
          entityId: id,
          safeInputSummary: {
            connectorKey: 'amocrm',
            pipelineId: parsed.data.pipelineId,
          },
        },
      });
    });
    return {
      pipelines: pipelines.map(({ id: pid, name, isMain }) => ({
        id: pid,
        name,
        isMain,
      })),
      pipelineId: parsed.data.pipelineId,
    };
  }

  /** The tenant's own active amoCRM connector, as a connector object. */
  private async load(
    tenantId: string,
    id: string,
  ): Promise<{
    connector: AmocrmConnector;
    config: Record<string, unknown>;
    pipelineId: number | null;
  }> {
    const row = await this.prisma.tenantConnector.findFirst({
      where: { id, tenantId, connectorKey: 'amocrm', status: 'ACTIVE' },
    });
    if (!row) throw refuse('NOT_FOUND');
    let connector;
    try {
      connector = await this.loader.create(row);
    } catch {
      throw refuse('CRM_REJECTED');
    }
    if (!(connector instanceof AmocrmConnector)) throw refuse('NOT_FOUND');
    const config = isObject(row.config) ? row.config : {};
    return {
      connector,
      config,
      pipelineId:
        typeof config.pipelineId === 'number' ? config.pipelineId : null,
    };
  }

  /** One read of the account through the connector's own allow-listed client. */
  private async check(
    tenantId: string,
    subdomain: string,
    token: string,
  ): Promise<void> {
    try {
      const probe = new AmocrmConnector(
        { tenantId, connectorKey: 'amocrm' },
        { subdomain, tokenSecretRef: TOKEN_REF },
        {
          resolveSecret: {
            resolve: (ref): string | undefined =>
              ref === TOKEN_REF ? token : undefined,
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
      throw this.failure('check', error);
    }
  }

  /** The code only is logged; the mapped refusal never carries a message. */
  private failure(step: string, error: unknown): HttpException {
    const code = error instanceof ConnectorError ? error.code : 'UNEXPECTED';
    this.logger.warn(
      JSON.stringify({ event: 'connector.amocrm_failed', step, code }),
    );
    if (error instanceof ConnectorUnauthorizedError)
      return refuse('TOKEN_INVALID');
    if (error instanceof ConnectorUnavailableError)
      return refuse('CRM_UNREACHABLE');
    if (
      error instanceof ConnectorError &&
      error.category === ConnectorErrorCategory.RATE_LIMITED
    )
      return refuse('CRM_UNREACHABLE');
    return refuse('CRM_REJECTED');
  }

  /** Only one CRM connector creates leads at a time (the mock stops). */
  private async stopOtherLeadSinks(tenantId: string): Promise<void> {
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
