import { describe, expect, it } from 'vitest';
import type { ConnectorSummary } from '@/lib/types';
import { connectorServesRole } from './connector-roles';

const summary = (capabilities?: string[]): ConnectorSummary => ({
  id: 'c1',
  connectorKey: 'x',
  status: 'ACTIVE',
  configured: true,
  ...(capabilities ? { capabilities } : {}),
});

describe('which connectors a role offers', () => {
  it('offers a lead-only connector (Bitrix24) for leads and actions, never for the catalog', () => {
    const bitrix = summary(['createLead']);
    expect(connectorServesRole(bitrix, 'LEAD_SINK')).toBe(true);
    expect(connectorServesRole(bitrix, 'ACTIONS')).toBe(true);
    expect(connectorServesRole(bitrix, 'CATALOG')).toBe(false);
  });

  it('offers a price list (search, quote, availability) for the catalog only', () => {
    const sheet = summary(['search', 'liveQuote', 'availability']);
    expect(connectorServesRole(sheet, 'CATALOG')).toBe(true);
    expect(connectorServesRole(sheet, 'LEAD_SINK')).toBe(false);
    expect(connectorServesRole(sheet, 'ACTIONS')).toBe(false);
  });

  it('offers a full connector for every role, and a booking-only one for actions', () => {
    const full = summary([
      'search',
      'createLead',
      'updateLead',
      'createBooking',
    ]);
    for (const role of ['CATALOG', 'LEAD_SINK', 'ACTIONS'] as const)
      expect(connectorServesRole(full, role)).toBe(true);
    expect(connectorServesRole(summary(['createBooking']), 'ACTIONS')).toBe(
      true,
    );
    expect(connectorServesRole(summary(['createBooking']), 'LEAD_SINK')).toBe(
      false,
    );
  });

  it('keeps offering everything when the API sends no capabilities (old server)', () => {
    for (const role of ['CATALOG', 'LEAD_SINK', 'ACTIONS'] as const)
      expect(connectorServesRole(summary(), role)).toBe(true);
    expect(connectorServesRole(summary([]), 'CATALOG')).toBe(false);
  });
});
