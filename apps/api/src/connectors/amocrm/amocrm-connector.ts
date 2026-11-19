import { Logger } from '@nestjs/common';
import {
  AmocrmConnectorConfigSchema,
  type AmocrmConnectorConfig,
} from '@agentcore/shared';
import { LeadInputSchema, type LeadInput } from '../contracts/canonical.js';
import type {
  ConnectorCapabilities,
  ConnectorContext,
  CrmConnector,
  WriteContext,
} from '../interfaces/crm-connector.js';
import {
  ConnectorConfigurationError,
  ConnectorError,
  ConnectorErrorCategory,
  ConnectorInvalidResponseError,
} from '../interfaces/errors.js';
import type { SecretResolver } from '../interfaces/secret-resolver.js';
import type {
  PortalStage,
  StageSyncSource,
  SyncLeadChange,
} from '../interfaces/stage-sync-source.js';
import { normalizePhone, plainText } from '../bitrix24/bitrix24-connector.js';
import { AmocrmClient, type AmocrmClientOptions } from './amocrm-client.js';
import {
  firstOpenStatus,
  LEADS_PAGE_SIZE,
  parseLeadChanges,
  parsePipelines,
  parseStatuses,
  toPortalStages,
  type AmocrmPipeline,
} from './amocrm-rules.js';

/** amoCRM stores long names; this is our own cap for the lead name. */
export const NAME_MAX = 255;

export interface AmocrmConnectorOptions {
  readonly resolveSecret: SecretResolver;
  /** Tests only: the transport and timing of the client. */
  readonly client?: Omit<AmocrmClientOptions, 'subdomain' | 'token'>;
}

/**
 * amoCRM as a lead sink (ADR 081): createLead through `leads/complex`
 * (lead, contact name and phone) into the chosen pipeline, plus the read side
 * of the stage sync. No catalog, quotes or availability.
 *
 * Write idempotency is `none`: the docs show no way to find a lead by our
 * key, so a create whose outcome is unclear is never repeated automatically.
 * The key is still sent as `request_id` (echoed back by the API).
 */
export class AmocrmConnector implements CrmConnector, StageSyncSource {
  private readonly logger = new Logger(AmocrmConnector.name);
  readonly connectorKey: string;
  readonly context: ConnectorContext;
  readonly capabilities: ConnectorCapabilities = {
    sync: false,
    search: false,
    liveQuote: false,
    availability: false,
    createLead: true,
    updateLead: false,
    createBooking: false,
    webhooks: false,
  };
  readonly writeIdempotency = 'none' as const;
  readonly stageSyncLabel = 'amoCRM';
  readonly stageSyncPageSize = LEADS_PAGE_SIZE;
  private readonly config: AmocrmConnectorConfig;
  private readonly client: AmocrmClient;

  constructor(
    context: ConnectorContext,
    rawConfig: unknown,
    options: AmocrmConnectorOptions,
  ) {
    this.context = context;
    this.connectorKey = context.connectorKey;
    const parsed = AmocrmConnectorConfigSchema.safeParse(rawConfig);
    if (!parsed.success) {
      throw new ConnectorConfigurationError({
        message: 'Invalid amoCRM connector configuration',
        code: 'CONNECTOR_INVALID_CONFIG',
        source: this.connectorKey,
      });
    }
    this.config = parsed.data;
    const token = options.resolveSecret.resolve(this.config.tokenSecretRef);
    if (!token) {
      throw new ConnectorConfigurationError({
        message: `Secret reference ${this.config.tokenSecretRef} did not resolve for connector '${this.connectorKey}'`,
        code: 'CONNECTOR_SECRET_MISSING',
        source: this.connectorKey,
      });
    }
    this.client = new AmocrmClient({
      ...options.client,
      subdomain: this.config.subdomain,
      token,
    });
  }

  /** One read of the account: proves the token and the subdomain work. */
  async validateConfiguration(): Promise<void> {
    const result = (await this.client.get('/api/v4/account')) as {
      id?: unknown;
    } | null;
    if (!result || typeof result.id !== 'number') {
      throw new ConnectorInvalidResponseError({
        message: 'amoCRM account answer has no id',
        code: 'AMOCRM_INVALID_ACCOUNT',
        source: this.connectorKey,
      });
    }
  }

  /** The account's active pipelines (for choosing where new leads go). */
  async listPipelines(): Promise<AmocrmPipeline[]> {
    return parsePipelines(await this.client.get('/api/v4/leads/pipelines'));
  }

  /** Stages of the chosen pipeline; none chosen yet means nothing to map. */
  async listStages(): Promise<PortalStage[]> {
    const pipelineId = this.config.pipelineId;
    if (pipelineId === undefined) return [];
    const result = await this.client.get('/api/v4/leads/pipelines');
    return toPortalStages(parseStatuses(result, pipelineId));
  }

  /**
   * One page (250, oldest change first) of leads of the chosen pipeline
   * changed since `since` (Unix seconds in `filter[updated_at][from]`).
   */
  async listChangedLeads(since: Date, page = 0): Promise<SyncLeadChange[]> {
    const pipelineId = this.config.pipelineId;
    if (pipelineId === undefined) return [];
    const result = await this.client.get('/api/v4/leads', {
      limit: LEADS_PAGE_SIZE,
      page: page + 1,
      'order[updated_at]': 'asc',
      'filter[updated_at][from]': Math.floor(since.getTime() / 1000),
      'filter[pipeline_id][0]': pipelineId,
    });
    return parseLeadChanges(result, pipelineId);
  }

  async createLead(
    input: LeadInput,
    context?: WriteContext,
  ): Promise<{ crmLeadId: string }> {
    const parsed = LeadInputSchema.safeParse(input);
    if (!parsed.success) {
      throw new ConnectorError({
        message: 'Invalid lead input',
        code: 'CONNECTOR_INVALID_INPUT',
        category: ConnectorErrorCategory.VALIDATION,
        source: this.connectorKey,
        executed: 'no',
      });
    }
    const lead = parsed.data;
    const placement = await this.placement();
    const phone = normalizePhone(lead.contact.phone);
    const name = lead.contact.name ? plainText(lead.contact.name, 100) : '';
    const body = [
      {
        name: plainText(
          `${this.config.titlePrefix}: ${name || 'new inquiry'}`,
          NAME_MAX,
        ),
        ...placement,
        ...(context ? { request_id: context.idempotencyKey } : {}),
        ...(name || phone
          ? {
              _embedded: {
                contacts: [
                  {
                    ...(name ? { name } : {}),
                    ...(phone
                      ? {
                          custom_fields_values: [
                            {
                              field_code: 'PHONE',
                              values: [{ enum_code: 'WORK', value: phone }],
                            },
                          ],
                        }
                      : {}),
                  },
                ],
              },
            }
          : {}),
      },
    ];
    const result = await this.client.post('/api/v4/leads/complex', body);
    const id = Array.isArray(result)
      ? (result[0] as { id?: unknown } | undefined)?.id
      : undefined;
    if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0) {
      throw new ConnectorInvalidResponseError({
        message: 'amoCRM leads/complex returned no lead id',
        code: 'AMOCRM_NO_LEAD_ID',
        source: this.connectorKey,
        executed: 'unknown',
      });
    }
    this.logger.log(
      JSON.stringify({
        event: 'amocrm.lead_created',
        connector: this.connectorKey,
        tenant: this.context.tenantId,
      }),
    );
    return { crmLeadId: String(id) };
  }

  /**
   * pipeline_id + status_id of the first open stage of the chosen pipeline.
   * Without a chosen pipeline neither is sent: the docs say the lead then
   * enters the first stage of the main pipeline.
   */
  private async placement(): Promise<{
    pipeline_id?: number;
    status_id?: number;
  }> {
    const pipelineId = this.config.pipelineId;
    if (pipelineId === undefined) return {};
    const result = await this.client.get('/api/v4/leads/pipelines');
    const first = firstOpenStatus(parseStatuses(result, pipelineId));
    if (!first) {
      throw new ConnectorConfigurationError({
        message: 'The chosen amoCRM pipeline has no open stage',
        code: 'AMOCRM_PIPELINE_UNAVAILABLE',
        source: this.connectorKey,
        executed: 'no',
      });
    }
    return { pipeline_id: pipelineId, status_id: first.id };
  }
}
