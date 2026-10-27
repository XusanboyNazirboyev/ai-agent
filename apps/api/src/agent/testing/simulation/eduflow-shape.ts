import type { Offer } from '../../../connectors/contracts/canonical.js';
import type { ConnectorCapabilities } from '../../../connectors/interfaces/crm-connector.js';

/**
 * EduFlow-shaped catalog for the simulation (owner instruction 2026-10-27;
 * connector plan on `docs/eduflow-connector-plan`). The real Learnix API has
 * no live quote, no availability or seats, no language or trial slots, and a
 * price without a currency. Under this profile the simulated connector says
 * exactly that, so slice 1b and the measurement ladder run under the same
 * constraints:
 * - IDs stay strings (as the canonical model already requires);
 * - `liveQuote` and `availability` are false and those calls are not offered;
 * - offers carry no seats and availability is UNKNOWN;
 * - a price keeps its amount only with an owner-declared currency; without
 *   one it is dropped (never guessed). Slice 1b-ii adds "currency not stated".
 */
export type SimConnectorProfile = 'mock' | 'eduflow';

export function eduflowCapabilities(
  capabilities: ConnectorCapabilities,
): ConnectorCapabilities {
  return { ...capabilities, liveQuote: false, availability: false };
}

export function eduflowOffer(offer: Offer, ownerCurrency?: string): Offer {
  const rest: Offer = { ...offer };
  delete rest.seatsLeft;
  delete rest.currency;
  delete rest.price;
  const { price } = offer;
  return {
    ...rest,
    availabilityStatus: 'UNKNOWN',
    ...(price && ownerCurrency
      ? { price: { amount: price.amount, currency: ownerCurrency } }
      : {}),
  };
}
