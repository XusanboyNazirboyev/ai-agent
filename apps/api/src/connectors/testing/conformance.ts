import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AvailabilitySchema,
  CatalogItemSchema,
  OfferSchema,
  QuoteSchema,
  type BookingInput,
  type LeadInput,
} from '../contracts/canonical.js';
import {
  CAPABILITY_METHODS,
  type ConnectorCapabilities,
  type CrmConnector,
} from '../interfaces/crm-connector.js';
import {
  ConnectorErrorCategory,
  isConnectorError,
} from '../interfaces/errors.js';

/**
 * Shared connector conformance suite (AGENTS.md §5.2: mandatory for every
 * connector). It exercises the canonical contract only, so any connector,
 * mock or real, can run it against fictional sample records.
 */

export interface ConformanceSubject {
  readonly connector: CrmConnector;
  readonly close?: () => Promise<void>;
}

export interface ConformanceSamples {
  /** Title fragment that matches at least one item. */
  readonly searchTitle?: string;
  /** Canonical id of a known item (getItem / getOffers). */
  readonly itemId?: string;
  /** Canonical id of a known, priced offer. */
  readonly offerId?: string;
  readonly missingItemId?: string;
  readonly missingOfferId?: string;
}

export interface ConformanceOptions {
  readonly name: string;
  readonly setup: () => Promise<ConformanceSubject>;
  readonly samples: ConformanceSamples;
}

const CAPABILITY_KEYS = Object.keys(CAPABILITY_METHODS) as Array<
  keyof ConnectorCapabilities
>;

const sampleLead: LeadInput = {
  contact: { name: 'Fictional Customer' },
  summary: 'Conformance test lead (fictional)',
  slots: {},
  reasonCodes: [],
};

async function expectConnectorRejection(
  promise: Promise<unknown>,
  category: ConnectorErrorCategory,
): Promise<void> {
  const error = await promise.then(
    () => undefined,
    (rejection: unknown) => rejection,
  );
  expect(error, 'operation must reject').toBeDefined();
  expect(isConnectorError(error), 'rejection must be a ConnectorError').toBe(
    true,
  );
  expect(error).toMatchObject({ category });
}

/** Calls the contract method behind a capability with plausible arguments. */
function invokeCapability(
  connector: CrmConnector,
  capability: keyof ConnectorCapabilities,
  samples: ConformanceSamples,
): Promise<unknown> {
  const offerId = samples.offerId ?? 'conformance-offer';
  const booking: BookingInput = {
    offerId,
    contact: { name: 'Fictional Customer' },
    details: {},
  };
  try {
    switch (capability) {
      case 'sync':
        return Promise.resolve(connector.listItems?.({}));
      case 'search':
        return Promise.resolve(connector.searchItems?.({ title: 'x' }));
      case 'liveQuote':
        return Promise.resolve(connector.getQuote?.(offerId, { offerId }));
      case 'availability':
        return Promise.resolve(
          connector.checkAvailability?.(offerId, { offerId }),
        );
      case 'createLead':
        return Promise.resolve(connector.createLead?.(sampleLead));
      case 'updateLead':
        return Promise.resolve(connector.updateLead?.('conformance-lead', {}));
      case 'createBooking':
        return Promise.resolve(connector.createBooking?.(booking));
      case 'webhooks':
        return Promise.resolve(
          connector.subscribeChanges?.({ handle: async () => undefined }),
        );
    }
  } catch (error: unknown) {
    return Promise.reject(error);
  }
}

export function describeConnectorConformance(
  options: ConformanceOptions,
): void {
  const { samples } = options;

  describe(`connector conformance: ${options.name}`, () => {
    let subject: ConformanceSubject;
    let connector: CrmConnector;

    beforeAll(async () => {
      subject = await options.setup();
      connector = subject.connector;
      await connector.initialize?.();
    });

    afterAll(async () => {
      await connector?.shutdown?.();
      await subject?.close?.();
    });

    it('declares every capability as a boolean', () => {
      for (const capability of CAPABILITY_KEYS) {
        expect(typeof connector.capabilities[capability], capability).toBe(
          'boolean',
        );
      }
    });

    it('implements every advertised capability', () => {
      for (const capability of CAPABILITY_KEYS) {
        if (!connector.capabilities[capability]) continue;
        expect(
          typeof connector[CAPABILITY_METHODS[capability]],
          capability,
        ).toBe('function');
      }
    });

    it('fails explicitly, never fakes success, for unadvertised capabilities', async () => {
      for (const capability of CAPABILITY_KEYS) {
        if (connector.capabilities[capability]) continue;
        if (typeof connector[CAPABILITY_METHODS[capability]] !== 'function') {
          continue; // absent methods cannot be called by mistake
        }
        await expectConnectorRejection(
          invokeCapability(connector, capability, samples),
          ConnectorErrorCategory.CAPABILITY,
        );
      }
    });

    it('lists schema-valid items with unique source identifiers', async (context) => {
      if (!connector.capabilities.sync) context.skip();
      const items = (await connector.listItems?.({})) ?? [];
      expect(items.length).toBeGreaterThan(0);
      for (const item of items) {
        expect(CatalogItemSchema.safeParse(item).success).toBe(true);
      }
      const keys = items.map(
        (item) => `${item.sourceSystem}:${item.sourceEntityId}`,
      );
      expect(new Set(keys).size).toBe(keys.length);
      expect(new Set(items.map((item) => item.id)).size).toBe(items.length);

      const limited = (await connector.listItems?.({ limit: 1 })) ?? [];
      expect(limited.length).toBe(1);
    });

    it('searches with schema-valid results and honest empty results', async (context) => {
      if (!connector.capabilities.search || !samples.searchTitle) {
        context.skip();
      }
      const found =
        (await connector.searchItems?.({ title: samples.searchTitle })) ?? [];
      expect(found.length).toBeGreaterThan(0);
      for (const item of found) {
        expect(CatalogItemSchema.safeParse(item).success).toBe(true);
      }
      await expect(
        connector.searchItems?.({ title: 'zz-no-such-fictional-item-zz' }),
      ).resolves.toEqual([]);
      const limited =
        (await connector.searchItems?.({
          title: samples.searchTitle,
          limit: 1,
        })) ?? [];
      expect(limited.length).toBeLessThanOrEqual(1);
    });

    it('rejects malformed search input as a validation error', async (context) => {
      if (!connector.capabilities.search) context.skip();
      await expectConnectorRejection(
        Promise.resolve().then(() => connector.searchItems?.({ limit: 0 })),
        ConnectorErrorCategory.VALIDATION,
      );
    });

    it('returns the requested item and reports a missing one as NOT_FOUND', async (context) => {
      if (!connector.getItem || !samples.itemId) context.skip();
      const item = await connector.getItem?.(samples.itemId!);
      expect(CatalogItemSchema.safeParse(item).success).toBe(true);
      expect(item?.id).toBe(samples.itemId);
      if (samples.missingItemId) {
        await expectConnectorRejection(
          connector.getItem!(samples.missingItemId),
          ConnectorErrorCategory.NOT_FOUND,
        );
      }
    });

    it('lists schema-valid offers that belong to the requested item', async (context) => {
      if (!connector.getOffers || !samples.itemId) context.skip();
      const offers = (await connector.getOffers?.(samples.itemId!)) ?? [];
      expect(offers.length).toBeGreaterThan(0);
      for (const offer of offers) {
        expect(OfferSchema.safeParse(offer).success).toBe(true);
        expect(offer.itemId).toBe(samples.itemId);
      }
    });

    it('checks live availability for the requested offer', async (context) => {
      if (!connector.capabilities.availability || !samples.offerId) {
        context.skip();
      }
      const offerId = samples.offerId!;
      const availability = await connector.checkAvailability?.(offerId, {
        offerId,
      });
      expect(AvailabilitySchema.safeParse(availability).success).toBe(true);
      expect(availability?.offerId).toBe(offerId);
      if (samples.missingOfferId) {
        await expectConnectorRejection(
          connector.checkAvailability!(samples.missingOfferId, {
            offerId: samples.missingOfferId,
          }),
          ConnectorErrorCategory.NOT_FOUND,
        );
      }
    });

    it('returns an exact live quote for the requested offer', async (context) => {
      if (!connector.capabilities.liveQuote || !samples.offerId) {
        context.skip();
      }
      const offerId = samples.offerId!;
      const quote = await connector.getQuote?.(offerId, { offerId });
      expect(QuoteSchema.safeParse(quote).success).toBe(true);
      expect(quote?.offerId).toBe(offerId);
      expect(quote?.amount.amount).toMatch(/^-?\d+(?:\.\d+)?$/);
      if (samples.missingOfferId) {
        await expectConnectorRejection(
          connector.getQuote!(samples.missingOfferId, {
            offerId: samples.missingOfferId,
          }),
          ConnectorErrorCategory.NOT_FOUND,
        );
      }
    });

    it('creates and updates leads, rejecting invalid input', async (context) => {
      if (!connector.capabilities.createLead) context.skip();
      const created = await connector.createLead?.(sampleLead);
      expect(typeof created?.crmLeadId).toBe('string');
      expect(created?.crmLeadId.length).toBeGreaterThan(0);
      await expectConnectorRejection(
        Promise.resolve().then(() =>
          connector.createLead?.({ summary: '' } as unknown as LeadInput),
        ),
        ConnectorErrorCategory.VALIDATION,
      );
      // Idempotency claims must hold (ADR 023): a connector that declares
      // native deduplication returns the original record for a repeated key;
      // a lookup connector finds what it created and nothing else.
      const mode = connector.writeIdempotency ?? 'none';
      if (mode === 'native') {
        const key = `conformance:native:${Date.now()}`;
        const first = await connector.createLead?.(sampleLead, {
          idempotencyKey: key,
        });
        const again = await connector.createLead?.(sampleLead, {
          idempotencyKey: key,
        });
        expect(again?.crmLeadId).toBe(first?.crmLeadId);
      }
      if (mode === 'lookup') {
        expect(typeof connector.findLeadByIdempotencyKey).toBe('function');
        const key = `conformance:lookup:${Date.now()}`;
        expect(await connector.findLeadByIdempotencyKey?.(key)).toBeUndefined();
        const made = await connector.createLead?.(sampleLead, {
          idempotencyKey: key,
        });
        expect(await connector.findLeadByIdempotencyKey?.(key)).toEqual({
          crmLeadId: made?.crmLeadId,
        });
      }
      if (connector.capabilities.updateLead && created) {
        await expect(
          connector.updateLead?.(created.crmLeadId, {
            summary: 'Updated fictional lead',
          }),
        ).resolves.toBeUndefined();
      }
    });

    it('creates bookings for a known offer', async (context) => {
      if (!connector.capabilities.createBooking || !samples.offerId) {
        context.skip();
      }
      const booking = await connector.createBooking?.({
        offerId: samples.offerId!,
        contact: { name: 'Fictional Customer' },
        details: {},
      });
      expect(typeof booking?.bookingId).toBe('string');
      expect(booking?.bookingId.length).toBeGreaterThan(0);
    });
  });
}
