import { Logger } from '@nestjs/common';
import {
  Bitrix24ConnectorConfigSchema,
  type Bitrix24ConnectorConfig,
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
import {
  Bitrix24Client,
  LEAD_ENTITY_TYPE_ID,
  type Bitrix24ClientOptions,
} from './bitrix24-client.js';

/** Stamped on every lead this connector creates (lead field `originatorId`). */
export const BITRIX24_ORIGINATOR_ID = 'tezda';
/** Bitrix24 stores at most 255 title characters (contract probe 2026-10-27). */
export const TITLE_MAX = 255;
/** Own cap: the docs state no comment limit. */
export const COMMENT_MAX = 4_000;
const COMMENTS_MAX = 1_000;

export interface DuplicateView {
  readonly exists: boolean;
  /** e.g. `LEAD:12` or `CONTACT:4`; null when nothing matched. */
  readonly internalId: string | null;
}

export interface Bitrix24ConnectorOptions {
  readonly resolveSecret: SecretResolver;
  /** Tests only: the transport and timing of the client. */
  readonly client?: Omit<Bitrix24ClientOptions, 'webhookUrl'>;
}

/**
 * Bitrix24 cloud as a lead sink (createLead only; no catalog, quotes or
 * availability). Plan and decisions: docs/connectors/bitrix24/CONNECTOR_PLAN.md.
 *
 * createLead: phone duplicate check first (IDs only leave the CRM). An
 * existing lead gets the conversation summary as a timeline comment and its
 * fields are never changed; a matching contact gets a new lead linked to it;
 * otherwise a new lead. The idempotency key is stored in `originId`, which
 * `crm.item.list` can filter (probe 2026-10-27), so writes are `lookup`.
 */
export class Bitrix24Connector implements CrmConnector {
  private readonly logger = new Logger(Bitrix24Connector.name);
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
  readonly writeIdempotency = 'lookup' as const;
  private readonly config: Bitrix24ConnectorConfig;
  private readonly client: Bitrix24Client;
  private leadsEnabled: Promise<void> | undefined;

  constructor(
    context: ConnectorContext,
    rawConfig: unknown,
    options: Bitrix24ConnectorOptions,
  ) {
    this.context = context;
    this.connectorKey = context.connectorKey;
    const parsed = Bitrix24ConnectorConfigSchema.safeParse(rawConfig);
    if (!parsed.success) {
      throw new ConnectorConfigurationError({
        message: 'Invalid Bitrix24 connector configuration',
        code: 'CONNECTOR_INVALID_CONFIG',
        source: this.connectorKey,
      });
    }
    this.config = parsed.data;
    const webhookUrl = options.resolveSecret.resolve(
      this.config.webhookSecretRef,
    );
    if (!webhookUrl) {
      throw new ConnectorConfigurationError({
        message: `Secret reference ${this.config.webhookSecretRef} did not resolve for connector '${this.connectorKey}'`,
        code: 'CONNECTOR_SECRET_MISSING',
        source: this.connectorKey,
      });
    }
    this.client = new Bitrix24Client({ ...options.client, webhookUrl });
  }

  /** Reads the CRM mode; simple CRM (no leads) is a configuration error. */
  async validateConfiguration(): Promise<void> {
    const { result } = await this.client.call('crm.settings.mode.get');
    if (result === 2) {
      throw new ConnectorConfigurationError({
        message:
          'Bitrix24 CRM runs in simple mode (no leads); lead creation is disabled',
        code: 'BITRIX24_LEADS_DISABLED',
        source: this.connectorKey,
      });
    }
    if (result !== 1) {
      throw new ConnectorInvalidResponseError({
        message: 'Bitrix24 returned an unknown CRM mode',
        code: 'BITRIX24_UNKNOWN_CRM_MODE',
        source: this.connectorKey,
      });
    }
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
    // Once per instance; a failed check is retried on the next write.
    this.leadsEnabled ??= this.validateConfiguration().catch((error) => {
      this.leadsEnabled = undefined;
      throw error;
    });
    await this.leadsEnabled;

    const phone = normalizePhone(lead.contact.phone);
    const duplicates = phone ? await this.findByPhone(phone) : undefined;
    const view = duplicateView(duplicates);
    this.logger.log(
      JSON.stringify({
        event: 'bitrix24.duplicate_check',
        connector: this.connectorKey,
        tenant: this.context.tenantId,
        checked: phone !== undefined,
        ...view,
      }),
    );

    const existingLead = await this.openLead(duplicates?.LEAD ?? []);
    if (existingLead !== undefined) {
      // The lead's fields are never changed, so the key travels in the
      // comment; a retry of this write finds it and does nothing.
      if (!context || !(await this.hasMarker(existingLead, context)))
        await this.comment(existingLead, lead, context);
      return { crmLeadId: String(existingLead) };
    }
    const contactId = duplicates?.CONTACT?.[0];
    const { result } = await this.client.call('crm.item.add', {
      entityTypeId: LEAD_ENTITY_TYPE_ID,
      fields: leadFields(this.config, lead, phone, contactId, context),
    });
    const id = (result as { item?: { id?: unknown } } | undefined)?.item?.id;
    if (typeof id !== 'number' && typeof id !== 'string') {
      throw new ConnectorInvalidResponseError({
        message: 'Bitrix24 crm.item.add returned no lead id',
        code: 'BITRIX24_NO_LEAD_ID',
        source: this.connectorKey,
        executed: 'unknown',
      });
    }
    await this.comment(id, lead, context);
    return { crmLeadId: String(id) };
  }

  async findLeadByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<{ crmLeadId: string } | undefined> {
    const { result } = await this.client.call('crm.item.list', {
      entityTypeId: LEAD_ENTITY_TYPE_ID,
      select: ['id', 'originatorId', 'originId'],
      filter: {
        originatorId: BITRIX24_ORIGINATOR_ID,
        originId: idempotencyKey,
      },
    });
    const items = (
      result as
        | {
            items?: Array<{
              id?: unknown;
              originatorId?: unknown;
              originId?: unknown;
            }>;
          }
        | undefined
    )?.items;
    if (!Array.isArray(items)) {
      throw new ConnectorInvalidResponseError({
        message: 'Bitrix24 crm.item.list returned no item list',
        code: 'BITRIX24_INVALID_LIST',
        source: this.connectorKey,
      });
    }
    // The docs do not define what a plain filter key matches, so the key is
    // checked again here; only an exact match counts.
    const id = items.find(
      (item) =>
        item.originatorId === BITRIX24_ORIGINATOR_ID &&
        item.originId === idempotencyKey,
    )?.id;
    return id === undefined ? undefined : { crmLeadId: String(id) };
  }

  /**
   * The newest matching lead that is still in progress (stageSemanticId P:
   * https://apidocs.bitrix24.com/api-reference/crm/universal/object-fields.html).
   * A converted (S) or junk (F) lead never absorbs a new inquiry.
   */
  private async openLead(ids: readonly number[]): Promise<number | undefined> {
    if (ids.length === 0) return undefined;
    const { result } = await this.client.call('crm.item.list', {
      entityTypeId: LEAD_ENTITY_TYPE_ID,
      select: ['id', 'stageSemanticId'],
      filter: { '@id': ids.slice(0, 20) },
    });
    const items = (
      result as
        | { items?: Array<{ id?: unknown; stageSemanticId?: unknown }> }
        | undefined
    )?.items;
    if (!Array.isArray(items)) {
      throw new ConnectorInvalidResponseError({
        message: 'Bitrix24 crm.item.list returned no item list',
        code: 'BITRIX24_INVALID_LIST',
        source: this.connectorKey,
      });
    }
    const open = items
      .filter((item) => item.stageSemanticId === 'P')
      .map((item) => Number(item.id))
      .filter((id) => ids.includes(id));
    return open.length ? Math.max(...open) : undefined;
  }

  private async findByPhone(phone: string): Promise<DuplicateIds> {
    const { result } = await this.client.call('crm.duplicate.findbycomm', {
      type: 'PHONE',
      values: [phone],
    });
    return parseDuplicates(result);
  }

  /**
   * The summary as a timeline comment. A failure is logged, not thrown: the
   * lead exists, and repeating the create would only add another comment.
   */
  /**
   * Whether one of the lead's latest comments (first page, newest first)
   * carries this write's key. A failed read throws: "could not determine"
   * must not turn into a second comment.
   */
  private async hasMarker(
    leadId: number,
    context: WriteContext,
  ): Promise<boolean> {
    const { result } = await this.client.call('crm.timeline.comment.list', {
      filter: { ENTITY_ID: leadId, ENTITY_TYPE: 'lead' },
      select: ['ID', 'COMMENT'],
      order: { ID: 'DESC' },
    });
    if (!Array.isArray(result)) {
      throw new ConnectorInvalidResponseError({
        message: 'Bitrix24 crm.timeline.comment.list returned no list',
        code: 'BITRIX24_INVALID_COMMENT_LIST',
        source: this.connectorKey,
      });
    }
    const marker = refLine(context.idempotencyKey);
    return result.some(
      (comment: { COMMENT?: unknown }) =>
        typeof comment.COMMENT === 'string' &&
        comment.COMMENT.split('\n').includes(marker),
    );
  }

  private async comment(
    leadId: number | string,
    lead: LeadInput,
    context?: WriteContext,
  ): Promise<void> {
    try {
      await this.client.call('crm.timeline.comment.add', {
        fields: {
          ENTITY_ID: Number(leadId),
          ENTITY_TYPE: 'lead',
          COMMENT: commentText(lead, context?.idempotencyKey),
        },
      });
    } catch (error: unknown) {
      this.logger.warn(
        JSON.stringify({
          event: 'bitrix24.comment_failed',
          connector: this.connectorKey,
          tenant: this.context.tenantId,
          lead: String(leadId),
          code: error instanceof ConnectorError ? error.code : 'unknown',
        }),
      );
    }
  }
}

type DuplicateIds = Partial<Record<'LEAD' | 'CONTACT' | 'COMPANY', number[]>>;

function parseDuplicates(result: unknown): DuplicateIds {
  // An empty match comes back as an empty array rather than an object.
  if (Array.isArray(result) || result === null || result === undefined)
    return {};
  if (typeof result !== 'object') {
    throw new ConnectorInvalidResponseError({
      message: 'Bitrix24 crm.duplicate.findbycomm returned an invalid result',
      code: 'BITRIX24_INVALID_DUPLICATES',
      source: 'bitrix24',
    });
  }
  const out: DuplicateIds = {};
  for (const type of ['LEAD', 'CONTACT', 'COMPANY'] as const) {
    const ids = (result as Record<string, unknown>)[type];
    // The docs show integer IDs; a numeric string is accepted too, because
    // dropping it would read as "no match" and create a duplicate lead.
    if (Array.isArray(ids))
      out[type] = ids.flatMap((id) =>
        typeof id === 'number' && Number.isInteger(id) && id > 0
          ? [id]
          : typeof id === 'string' && /^[1-9]\d{0,18}$/u.test(id)
            ? [Number(id)]
            : [],
      );
  }
  return out;
}

/** All that may leave the connector about other CRM records. */
export function duplicateView(ids: DuplicateIds | undefined): DuplicateView {
  for (const type of ['LEAD', 'CONTACT', 'COMPANY'] as const) {
    const id = ids?.[type]?.[0];
    if (id !== undefined) return { exists: true, internalId: `${type}:${id}` };
  }
  return { exists: false, internalId: null };
}

/**
 * E.164-like: `+` and 8–15 digits when the number is international (`+` or
 * `00`); otherwise the digits only. Anything else is not sent.
 */
export function normalizePhone(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  const digits = trimmed.replace(/\D/gu, '');
  if (trimmed.startsWith('+') || trimmed.startsWith('00')) {
    const international = trimmed.startsWith('00') ? digits.slice(2) : digits;
    return /^\d{8,15}$/u.test(international) ? `+${international}` : undefined;
  }
  return /^\d{7,15}$/u.test(digits) ? digits : undefined;
}

/**
 * Customer and CRM text is untrusted: control characters are dropped, and
 * BBCode/HTML brackets become look-alikes, so nothing renders as markup.
 */
export function plainText(text: string, max: number): string {
  const clean = text
    // Control characters (except tab and newline) become spaces.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/gu, ' ')
    .replace(/\[/gu, '⟦')
    .replace(/\]/gu, '⟧')
    .replace(/</gu, '‹')
    .replace(/>/gu, '›')
    .trim();
  // Counted in code points, so a cut never splits a surrogate pair (an
  // emoji); Bitrix24 limits are in characters (field-length-limits).
  const chars = Array.from(clean);
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : clean;
}

function leadFields(
  config: Bitrix24ConnectorConfig,
  lead: LeadInput,
  phone: string | undefined,
  contactId: number | undefined,
  context: WriteContext | undefined,
): Record<string, unknown> {
  const who = lead.contact.name
    ? plainText(lead.contact.name, 100)
    : 'new inquiry';
  const notes = [
    lead.score ? `Score ${lead.score}` : undefined,
    lead.reasonCodes.length
      ? `reasons: ${lead.reasonCodes.join(', ')}`
      : undefined,
  ].filter(Boolean);
  return {
    title: plainText(`${config.titlePrefix}: ${who}`, TITLE_MAX),
    ...(lead.contact.name ? { name: plainText(lead.contact.name, 100) } : {}),
    sourceId: config.sourceId,
    sourceDescription: 'tezda (Telegram)',
    ...(notes.length
      ? { comments: plainText(notes.join('; '), COMMENTS_MAX) }
      : {}),
    originatorId: BITRIX24_ORIGINATOR_ID,
    ...(context ? { originId: context.idempotencyKey } : {}),
    ...(phone
      ? { fm: [{ typeId: 'PHONE', valueType: 'MOBILE', value: phone }] }
      : {}),
    ...(contactId !== undefined ? { contactId } : {}),
  };
}

/** The last line of a comment: the write's idempotency key (header-safe). */
export function refLine(idempotencyKey: string): string {
  return `tezda ref: ${idempotencyKey}`;
}

/** Summary plus collected slots (v1: no custom-field mapping), then the key. */
export function commentText(lead: LeadInput, idempotencyKey?: string): string {
  const slots = Object.entries(lead.slots)
    .filter(
      ([, value]) => value !== undefined && value !== null && value !== '',
    )
    .map(
      ([key, value]) =>
        `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`,
    );
  const text = [
    'Telegram conversation (tezda)',
    lead.summary,
    ...(slots.length ? ['', 'Collected details:', ...slots] : []),
  ].join('\n');
  if (!idempotencyKey) return plainText(text, COMMENT_MAX);
  // The key (at most 200 characters) is kept even when the text is capped.
  return `${plainText(text, COMMENT_MAX - 240)}\n\n${refLine(idempotencyKey)}`;
}
