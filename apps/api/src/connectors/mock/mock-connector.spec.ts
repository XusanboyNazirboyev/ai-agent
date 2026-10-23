import { describe, expect, it } from 'vitest';
import { ConnectorErrorCategory } from '../interfaces/errors.js';
import { MockConnector, type MockFailureMode } from './mock-connector.js';
import { allFixtures } from './mock-fixtures.js';

function mock(failureMode: MockFailureMode, failTimes?: number): MockConnector {
  return new MockConnector(
    { tenantId: 'tenant-a', connectorKey: 'mock' },
    {
      sourceSystem: 'mock-education',
      items: allFixtures('mock-education'),
      failureMode,
      failTimes,
    },
  );
}

describe('MockConnector failure simulation', () => {
  it.each([
    ['timeout', ConnectorErrorCategory.TIMEOUT, true],
    ['transient', ConnectorErrorCategory.UNAVAILABLE, true],
    ['invalidResponse', ConnectorErrorCategory.INVALID_RESPONSE, false],
  ] as const)(
    '%s fails with a typed %s error',
    async (mode, category, retryable) => {
      await expect(mock(mode).listItems()).rejects.toMatchObject({
        category,
        retryable,
      });
    },
  );

  it('recovers after the configured number of failures', async () => {
    const connector = mock('transient', 2);
    await expect(connector.listItems()).rejects.toThrow();
    await expect(connector.listItems()).rejects.toThrow();
    await expect(connector.listItems()).resolves.toHaveLength(2);
    expect(connector.calls).toBe(3);
  });

  it('returns an honest empty search result', async () => {
    await expect(
      mock('emptySearch').searchItems({ title: 'IELTS' }),
    ).resolves.toEqual([]);
  });

  it('applies attribute filters exactly', async () => {
    const connector = mock('none');
    await expect(
      connector.searchItems({ attributes: { format: 'online' } }),
    ).resolves.toMatchObject([{ sourceEntityId: 'edu-ielts-001' }]);
    await expect(
      connector.searchItems({ attributes: { format: 'hybrid' } }),
    ).resolves.toEqual([]);
  });

  it('refuses bookings for unknown offers', async () => {
    await expect(
      mock('none').createBooking({
        offerId: 'mock-education:offer:missing',
        contact: {},
        details: {},
      }),
    ).rejects.toMatchObject({ category: ConnectorErrorCategory.NOT_FOUND });
  });
});
