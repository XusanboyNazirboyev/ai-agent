import { describe, expect, it } from 'vitest';
import { simulationConnector } from './world.js';

const ITEM = 'mock-education:edu-ielts-001';

describe('simulation connector profiles', () => {
  it('keeps the default mock unchanged (live quote and availability, seats, listed currency)', async () => {
    const connector = simulationConnector('t1', 'mock-education');
    expect(connector.capabilities).toMatchObject({
      liveQuote: true,
      availability: true,
    });
    expect(connector.getQuote).toBeTypeOf('function');
    const [offer] = await connector.getOffers!(ITEM);
    expect(offer?.seatsLeft).toBeTypeOf('number');
    expect(offer?.price?.currency).toBe('USD');
  });

  it('is EduFlow-shaped on request: no live calls, no seats, availability unknown, no guessed currency', async () => {
    const connector = simulationConnector('t1', 'mock-education', {
      SIM_CONNECTOR_PROFILE: 'eduflow',
    });
    expect(connector.capabilities).toMatchObject({
      liveQuote: false,
      availability: false,
    });
    expect(connector.getQuote).toBeUndefined();
    expect(connector.checkAvailability).toBeUndefined();
    const offers = await connector.getOffers!(ITEM);
    expect(offers.length).toBeGreaterThan(0);
    for (const offer of offers) {
      expect(typeof offer.id).toBe('string');
      expect(typeof offer.itemId).toBe('string');
      expect(offer.seatsLeft).toBeUndefined();
      expect(offer.availabilityStatus).toBe('UNKNOWN');
      expect(offer.price).toBeUndefined();
      expect(offer.startsAt).toBeTypeOf('string');
    }
  });

  it('uses only the owner-declared currency for a price', async () => {
    const connector = simulationConnector('t1', 'mock-education', {
      SIM_CONNECTOR_PROFILE: 'eduflow',
      SIM_OWNER_CURRENCY: 'UZS',
    });
    const [offer] = await connector.getOffers!(ITEM);
    expect(offer?.price).toEqual({ amount: '150.00', currency: 'UZS' });
    expect(offer?.seatsLeft).toBeUndefined();
  });
});
