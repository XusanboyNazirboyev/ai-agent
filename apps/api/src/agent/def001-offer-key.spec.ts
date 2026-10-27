import { describe, expect, it } from 'vitest';
import { ScriptedLlmProvider } from '../core/llm/scripted-llm-provider.js';
import {
  educationConnector,
  extraction,
  runTurn,
} from './testing/agent-harness.js';

/**
 * DEF-001, the product part (slice 1b-i diagnosis). `ShownOffersService`
 * looks the synced offer up by `sourceEntityId = provenance.offerId`, but the
 * fact carries the connector's canonical offer id while catalog sync stores
 * the offer under its source id (`catalog-sync.store.ts`: `sourceEntityId:
 * offer.sourceEntityId`). The lookup misses, so no `Quote` row is written for
 * a synced offer (the ShownOffer row and follow-ups are unaffected).
 * Fixed in 1b-i commit C: facts also carry `offerSourceEntityId`.
 */
describe('DEF-001: shown-offer lookup key vs the synced offer key', () => {
  it('a live quote fact carries both the canonical offer id and the synced source id', async () => {
    const connector = educationConnector();
    const offers = await connector.getOffers!('mock-education:edu-ielts-001');
    const weekday = offers.find((offer) =>
      offer.id.endsWith('ielts-group-weekday'),
    )!;
    const { result } = await runTurn({
      provider: new ScriptedLlmProvider([
        extraction({ subject: 'IELTS' }, 'price'),
        {
          kind: 'tools',
          toolCalls: [
            { name: 'list_offers', input: { itemId: weekday.itemId } },
          ],
        },
        {
          kind: 'tools',
          toolCalls: [{ name: 'get_quote', input: { offerId: weekday.id } }],
        },
        { kind: 'tools', text: '{{F1}} kursi narxi: {{F10}}.' },
      ]),
      connector,
      text: 'IELTS kursi narxi qancha?',
    });
    const quote = result.facts.find(
      (fact) => fact.value.kind === 'price' && fact.value.confirmedQuote,
    )!;
    // The canonical id stays the evidence binding ...
    expect(quote.provenance.offerId).toBe(
      'mock-education:offer:ielts-group-weekday',
    );
    // ... and the fact also names the key catalog sync stores, which
    // ShownOffersService now uses to find the synced offer (fixed).
    expect(weekday.sourceEntityId).toBe('ielts-group-weekday');
    expect(quote.provenance.offerSourceEntityId).toBe(weekday.sourceEntityId);
    const listed = result.facts.find(
      (fact) => fact.value.kind === 'price' && !fact.value.confirmedQuote,
    )!;
    expect(listed.provenance.offerSourceEntityId).toBe(weekday.sourceEntityId);
  });
});
