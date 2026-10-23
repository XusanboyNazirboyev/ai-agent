import {
  unifyApostrophes,
  updatedLatnToLegacy,
  uzCyrlToLatn,
  type AgentToolName,
  type DomainPack,
} from '@agentcore/shared';
import { z } from 'zod';
import {
  AvailabilitySchema,
  CatalogItemSchema,
  OfferSchema,
  QuoteSchema,
  type Availability,
  type CatalogItem,
  type Offer,
  type Quote,
} from '../../connectors/contracts/canonical.js';
import type { CanonicalQuery } from '../../connectors/contracts/canonical.js';
import type { CrmConnector } from '../../connectors/interfaces/crm-connector.js';
import {
  ConnectorErrorCategory,
  isConnectorError,
} from '../../connectors/interfaces/errors.js';
import type { TurnBudget } from '../llm/budget.js';
import type { LlmToolDefinition } from '../llm/llm-provider.js';
import type { FactProvenance, FactStore } from './facts.js';
import { redactedSummary } from './redaction.js';
import type { SlotState } from './slots.js';
import { searchQuery } from './slots.js';

/**
 * Tool registry and executor (D16, AGENTS.md §7.2). The model only proposes
 * calls; this code decides whether a call is allowed and runs it:
 *  - the tool must be registered, enabled by the pack and supported by the
 *    tenant's connector (unsupported tools are never offered);
 *  - arguments are validated; ids must come from this turn's own results,
 *    so the model cannot probe arbitrary records;
 *  - calls are counted against the turn budget, deduplicated and time-bound;
 *  - the connector is the tenant's own instance, chosen server-side; the
 *    model never picks a tenant, credential or destination;
 *  - every tool here is read-only (side-effect class READ); write tools
 *    (leads, bookings) are not exposed to the model in this phase;
 *  - connector text (titles, descriptions, attributes) is untrusted data:
 *    it is serialized with `<`/`>` escaped so it cannot close the prompt's
 *    data delimiters, and the prompt tells the model to ignore instructions
 *    in it.
 */

/** Side-effect class of a tool; only READ tools exist in this phase. */
export type ToolSideEffect = 'READ' | 'WRITE_IDEMPOTENT' | 'WRITE_EXTERNAL';

export const TOOL_SIDE_EFFECTS: Readonly<
  Record<AgentToolName, ToolSideEffect>
> = {
  search_catalog: 'READ',
  get_item_details: 'READ',
  list_offers: 'READ',
  check_availability: 'READ',
  get_quote: 'READ',
};

/**
 * Typed result class of a tool call (addendum §3.2). REJECTED means the
 * server refused the call before it reached the connector.
 */
export type ToolOutcomeType =
  | 'FOUND'
  | 'NOT_FOUND'
  | 'STALE'
  | 'UNAVAILABLE'
  | 'INVALID_RESPONSE'
  | 'REJECTED';

export type ToolErrorCode =
  | 'UNKNOWN_TOOL'
  | 'UNSUPPORTED'
  | 'INVALID_ARGUMENTS'
  | 'UNKNOWN_REFERENCE'
  | 'DUPLICATE_CALL'
  | 'TIMEOUT'
  | 'NOT_FOUND'
  | 'STALE'
  | 'INVALID_OUTPUT'
  | 'UNAVAILABLE';

const OUTCOME_OF_ERROR: Readonly<Record<ToolErrorCode, ToolOutcomeType>> = {
  UNKNOWN_TOOL: 'REJECTED',
  UNSUPPORTED: 'REJECTED',
  INVALID_ARGUMENTS: 'REJECTED',
  UNKNOWN_REFERENCE: 'REJECTED',
  DUPLICATE_CALL: 'REJECTED',
  TIMEOUT: 'UNAVAILABLE',
  UNAVAILABLE: 'UNAVAILABLE',
  NOT_FOUND: 'NOT_FOUND',
  STALE: 'STALE',
  INVALID_OUTPUT: 'INVALID_RESPONSE',
};

/** JSON for the model with markup characters escaped (still valid JSON). */
function promptSafeJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</gu, '\\u003c')
    .replace(/>/gu, '\\u003e');
}

export type ToolOutcome =
  | {
      readonly ok: true;
      readonly outcome: ToolOutcomeType;
      readonly summary: string;
      readonly items: readonly CatalogItem[];
    }
  | {
      readonly ok: false;
      readonly outcome: ToolOutcomeType;
      readonly code: ToolErrorCode;
      readonly summary: string;
    };

export interface ToolTraceEntry {
  readonly name: string;
  readonly origin: 'code' | 'model';
  readonly status: 'ok' | 'error';
  readonly outcome: ToolOutcomeType;
  readonly code?: ToolErrorCode;
  /** Validated (or rejected) input, PII-redacted, for audit records. */
  readonly input: Readonly<Record<string, string>>;
  readonly durationMs: number;
}

export interface ToolContext {
  readonly connector: CrmConnector;
  readonly pack: DomainPack;
  readonly facts: FactStore;
  readonly budget: TurnBudget;
  readonly timeoutMs: number;
  readonly now: () => Date;
  /** Turn scope stamped on every fact; checked again by the display gate. */
  readonly scope: {
    readonly tenantId: string;
    readonly conversationId: string;
  };
}

const ID = z.string().min(1).max(300);
const INPUTS = {
  search_catalog: z.object({ query: z.string().min(1).max(120) }).strict(),
  get_item_details: z.object({ itemId: ID }).strict(),
  list_offers: z.object({ itemId: ID }).strict(),
  check_availability: z.object({ offerId: ID }).strict(),
  get_quote: z.object({ offerId: ID }).strict(),
} as const;

const idSchema = (
  name: string,
  description: string,
): Record<string, unknown> => ({
  type: 'object',
  additionalProperties: false,
  required: [name],
  properties: { [name]: { type: 'string', description } },
});

const DEFINITIONS: Readonly<Record<AgentToolName, LlmToolDefinition>> = {
  search_catalog: {
    name: 'search_catalog',
    description:
      'Search the catalog by name or keywords. Use only when the customer asks for something the current results do not cover.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: {
        query: { type: 'string', description: 'Item name or keywords' },
      },
    },
  },
  get_item_details: {
    name: 'get_item_details',
    description:
      'Get the description and attributes of one item from the results.',
    inputSchema: idSchema('itemId', 'itemId exactly as given in the results'),
  },
  list_offers: {
    name: 'list_offers',
    description:
      'List the offers (variants, dates, packages) of one item, with listed prices, seats and start times.',
    inputSchema: idSchema('itemId', 'itemId exactly as given in the results'),
  },
  check_availability: {
    name: 'check_availability',
    description: 'Check live availability and seats of one offer.',
    inputSchema: idSchema('offerId', 'offerId exactly as given by list_offers'),
  },
  get_quote: {
    name: 'get_quote',
    description: 'Get a live, confirmed price quote for one offer.',
    inputSchema: idSchema('offerId', 'offerId exactly as given by list_offers'),
  },
};

function supported(connector: CrmConnector, name: AgentToolName): boolean {
  switch (name) {
    case 'search_catalog':
      return (
        connector.capabilities.search &&
        typeof connector.searchItems === 'function'
      );
    case 'get_item_details':
      return typeof connector.getItem === 'function';
    case 'list_offers':
      return typeof connector.getOffers === 'function';
    case 'check_availability':
      return (
        connector.capabilities.availability &&
        typeof connector.checkAvailability === 'function'
      );
    case 'get_quote':
      return (
        connector.capabilities.liveQuote &&
        typeof connector.getQuote === 'function'
      );
  }
}

export class AgentTools {
  private readonly knownItems = new Set<string>();
  private readonly knownOffers = new Set<string>();
  private readonly seenCalls = new Set<string>();
  readonly trace: ToolTraceEntry[] = [];

  constructor(private readonly context: ToolContext) {}

  /** Pack-enabled tools the tenant's connector actually supports. */
  available(): AgentToolName[] {
    return this.context.pack.tools.filter((name) =>
      supported(this.context.connector, name),
    );
  }

  definitions(): LlmToolDefinition[] {
    return this.available().map((name) => DEFINITIONS[name]);
  }

  private provenance(
    tool: string,
    sourceEntityId: string,
    sourceSystem: string,
    validUntil?: string,
    binding: { offerId?: string; live?: boolean } = {},
  ): FactProvenance {
    return {
      tool,
      connectorKey: this.context.connector.connectorKey,
      sourceSystem,
      sourceEntityId,
      retrievedAt: this.context.now().toISOString(),
      ...(validUntil ? { validUntil } : {}),
      tenantId: this.context.connector.context.tenantId,
      conversationId: this.context.scope.conversationId,
      ...binding,
    };
  }

  private isStale(validUntil: string | undefined): boolean {
    return (
      validUntil !== undefined &&
      new Date(validUntil).getTime() <= this.context.now().getTime()
    );
  }

  private describeItems(tool: string, items: readonly CatalogItem[]): string {
    return promptSafeJson({
      items: items.map((item) => {
        this.knownItems.add(item.id);
        const titleFact = this.context.facts.add(
          { kind: 'title', text: item.title },
          this.provenance(tool, item.sourceEntityId, item.sourceSystem),
        );
        return {
          itemId: item.id,
          titleFact,
          title: item.title,
          ...(item.description ? { description: item.description } : {}),
          attributes: item.attributes,
        };
      }),
    });
  }

  private describeOffers(offers: readonly Offer[]): string {
    const { facts } = this.context;
    return promptSafeJson({
      offers: offers.map((offer) => {
        this.knownOffers.add(offer.id);
        // An expired offer yields no facts: its price, seats and dates are
        // not current and must be re-checked live before anyone sees them.
        if (this.isStale(offer.validUntil)) {
          return {
            offerId: offer.id,
            itemId: offer.itemId,
            stale: true,
            note: 'listing expired; use check_availability or get_quote',
          };
        }
        const p = this.provenance(
          'list_offers',
          offer.sourceEntityId,
          offer.sourceSystem,
          offer.validUntil,
          { offerId: offer.id, live: false },
        );
        return {
          offerId: offer.id,
          itemId: offer.itemId,
          ...(offer.price
            ? {
                priceFact: facts.add(
                  { kind: 'price', money: offer.price, confirmedQuote: false },
                  p,
                ),
                price: `${offer.price.amount} ${offer.price.currency}`,
                pricingBasis: offer.pricingBasis,
              }
            : { price: 'not listed' }),
          availabilityFact: facts.add(
            { kind: 'availability', status: offer.availabilityStatus },
            p,
          ),
          ...(offer.seatsLeft !== undefined
            ? {
                seatsFact: facts.add(
                  { kind: 'seats', count: offer.seatsLeft },
                  p,
                ),
                seatsLeft: offer.seatsLeft,
              }
            : {}),
          ...(offer.startsAt
            ? {
                startsAtFact: facts.add(
                  { kind: 'datetime', iso: offer.startsAt },
                  p,
                ),
              }
            : {}),
          attributes: offer.attributes,
        };
      }),
    });
  }

  private describeAvailability(
    availability: Availability,
    sourceSystem: string,
  ): string {
    const p = this.provenance(
      'check_availability',
      availability.offerId,
      sourceSystem,
      availability.validUntil,
      { offerId: availability.offerId, live: true },
    );
    return promptSafeJson({
      offerId: availability.offerId,
      live: true,
      availabilityFact: this.context.facts.add(
        { kind: 'availability', status: availability.status },
        p,
      ),
      ...(availability.seatsLeft !== undefined
        ? {
            seatsFact: this.context.facts.add(
              { kind: 'seats', count: availability.seatsLeft },
              p,
            ),
            seatsLeft: availability.seatsLeft,
          }
        : {}),
    });
  }

  private describeQuote(quote: Quote): string {
    const p = this.provenance(
      'get_quote',
      quote.sourceEntityId,
      quote.sourceSystem,
      quote.validUntil,
      { offerId: quote.offerId, live: true },
    );
    return promptSafeJson({
      offerId: quote.offerId,
      live: true,
      confirmedPriceFact: this.context.facts.add(
        { kind: 'price', money: quote.amount, confirmedQuote: true },
        p,
      ),
      price: `${quote.amount.amount} ${quote.amount.currency}`,
      pricingBasis: quote.pricingBasis,
    });
  }

  private fail(
    name: string,
    origin: 'code' | 'model',
    code: ToolErrorCode,
    started: number,
    input: Readonly<Record<string, unknown>>,
  ): ToolOutcome {
    const outcome = OUTCOME_OF_ERROR[code];
    this.trace.push({
      name,
      origin,
      status: 'error',
      outcome,
      code,
      input: redactedSummary(input),
      durationMs: Date.now() - started,
    });
    return {
      ok: false,
      outcome,
      code,
      summary: promptSafeJson({ error: code }),
    };
  }

  private withTimeout<T>(work: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error('TOOL_TIMEOUT')),
        this.context.timeoutMs,
      );
    });
    return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
  }

  /** Code-initiated catalog search from the slot state (value early). */
  searchBySlots(state: SlotState, requiredOnly = false): Promise<ToolOutcome> {
    return this.runSearch(
      searchQuery(this.context.pack, state, { requiredOnly }),
    );
  }

  /**
   * The same search with the title spelled in canonical legacy Uzbek Latin
   * (updated letters and Cyrillic folded). Only a query is rewritten; stored
   * connector data is never touched. Undefined when it would not differ.
   */
  searchByOrthographicVariant(
    state: SlotState,
    requiredOnly = false,
  ): Promise<ToolOutcome> | undefined {
    const query = searchQuery(this.context.pack, state, { requiredOnly });
    if (query.title === undefined) return undefined;
    const variant = uzCyrlToLatn(
      updatedLatnToLegacy(unifyApostrophes(query.title)),
    );
    if (variant === query.title) return undefined;
    return this.runSearch({ ...query, title: variant });
  }

  private runSearch(query: CanonicalQuery): Promise<ToolOutcome> {
    return this.execute(
      'search_catalog',
      'code',
      {
        title: query.title,
        attributes: Object.keys(query.attributes ?? {}).join(','),
      },
      () => this.context.connector.searchItems!(query),
    );
  }

  /** Runs a model-proposed call after validating it. */
  async run(name: string, rawInput: unknown): Promise<ToolOutcome> {
    const started = Date.now();
    const tool = name as AgentToolName;
    // Rejected input is summarized by its keys only: it is unvalidated.
    const rawKeys =
      rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput)
        ? { keys: Object.keys(rawInput).slice(0, 10).join(',') }
        : { keys: typeof rawInput };
    if (
      !Object.prototype.hasOwnProperty.call(INPUTS, name) ||
      !this.context.pack.tools.includes(tool)
    ) {
      return this.fail(
        name.slice(0, 60),
        'model',
        'UNKNOWN_TOOL',
        started,
        rawKeys,
      );
    }
    if (!supported(this.context.connector, tool))
      return this.fail(name, 'model', 'UNSUPPORTED', started, rawKeys);
    const parsed = INPUTS[tool].safeParse(rawInput);
    if (!parsed.success)
      return this.fail(name, 'model', 'INVALID_ARGUMENTS', started, rawKeys);
    const input = parsed.data as Record<string, string>;
    if ('itemId' in input && !this.knownItems.has(input.itemId)) {
      return this.fail(name, 'model', 'UNKNOWN_REFERENCE', started, input);
    }
    if ('offerId' in input && !this.knownOffers.has(input.offerId)) {
      return this.fail(name, 'model', 'UNKNOWN_REFERENCE', started, input);
    }
    const signature = `${name}:${JSON.stringify(input)}`;
    if (this.seenCalls.has(signature))
      return this.fail(name, 'model', 'DUPLICATE_CALL', started, input);
    this.seenCalls.add(signature);

    const { connector, pack } = this.context;
    switch (tool) {
      case 'search_catalog':
        return this.execute(name, 'model', input, () =>
          connector.searchItems!({
            itemType: pack.catalogItemType,
            title: input.query,
            limit: pack.maxOptionsShown,
          }),
        );
      case 'get_item_details':
        return this.execute(name, 'model', input, async () => [
          await connector.getItem!(input.itemId),
        ]);
      case 'list_offers':
        return this.execute(
          name,
          'model',
          input,
          () => connector.getOffers!(input.itemId),
          'offers',
        );
      case 'check_availability':
        return this.execute(
          name,
          'model',
          input,
          () =>
            connector.checkAvailability!(input.offerId, {
              offerId: input.offerId,
            }),
          'availability',
          input.offerId,
        );
      case 'get_quote':
        return this.execute(
          name,
          'model',
          input,
          () => connector.getQuote!(input.offerId, { offerId: input.offerId }),
          'quote',
          input.offerId,
        );
    }
  }

  private async execute(
    name: string,
    origin: 'code' | 'model',
    input: Readonly<Record<string, unknown>>,
    work: () => Promise<unknown>,
    shape: 'items' | 'offers' | 'availability' | 'quote' = 'items',
    expectedOfferId?: string,
  ): Promise<ToolOutcome> {
    const started = Date.now();
    this.context.budget.countToolCall();
    let result: unknown;
    try {
      result = await this.withTimeout(work());
    } catch (error: unknown) {
      if (error instanceof Error && error.message === 'TOOL_TIMEOUT') {
        return this.fail(name, origin, 'TIMEOUT', started, input);
      }
      const notFound =
        isConnectorError(error) &&
        error.category === ConnectorErrorCategory.NOT_FOUND;
      return this.fail(
        name,
        origin,
        notFound ? 'NOT_FOUND' : 'UNAVAILABLE',
        started,
        input,
      );
    }
    // Connector output is validated again here: the agent never renders a
    // record that does not satisfy the canonical contract or answers a
    // different offer than the one requested.
    const schema = {
      items: z.array(CatalogItemSchema),
      offers: z.array(OfferSchema),
      availability: AvailabilitySchema,
      quote: QuoteSchema,
    }[shape];
    const valid = schema.safeParse(result);
    if (
      !valid.success ||
      (expectedOfferId !== undefined &&
        (valid.data as { offerId: string }).offerId !== expectedOfferId)
    ) {
      return this.fail(name, origin, 'INVALID_OUTPUT', started, input);
    }
    result = valid.data;
    // A live check whose own validity window has already closed is not a
    // current fact: report it as STALE instead of rendering it.
    if (
      (shape === 'availability' || shape === 'quote') &&
      this.isStale((result as { validUntil?: string }).validUntil)
    ) {
      return this.fail(name, origin, 'STALE', started, input);
    }
    const outcome: ToolOutcomeType =
      shape === 'items'
        ? (result as CatalogItem[]).length > 0
          ? 'FOUND'
          : 'NOT_FOUND'
        : shape === 'offers'
          ? (result as Offer[]).length === 0
            ? 'NOT_FOUND'
            : (result as Offer[]).every((offer) =>
                  this.isStale(offer.validUntil),
                )
              ? 'STALE'
              : 'FOUND'
          : 'FOUND';
    this.trace.push({
      name,
      origin,
      status: 'ok',
      outcome,
      input: redactedSummary(input),
      durationMs: Date.now() - started,
    });
    const sourceSystem =
      this.context.connector.sourceSystem ??
      this.context.connector.connectorKey;
    switch (shape) {
      case 'items': {
        const items = result as CatalogItem[];
        return {
          ok: true,
          outcome,
          summary: this.describeItems(name, items),
          items,
        };
      }
      case 'offers':
        return {
          ok: true,
          outcome,
          summary: this.describeOffers(result as Offer[]),
          items: [],
        };
      case 'availability':
        return {
          ok: true,
          outcome,
          summary: this.describeAvailability(
            result as Availability,
            sourceSystem,
          ),
          items: [],
        };
      case 'quote':
        return {
          ok: true,
          outcome,
          summary: this.describeQuote(result as Quote),
          items: [],
        };
    }
  }
}
