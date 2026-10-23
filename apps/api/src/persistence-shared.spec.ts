import {
  CatalogAttributesSchema,
  CurrencyCodeSchema,
  ConversationSlotsSchema,
  DomainPackKeySchema,
  HandoverReasonCodeSchema,
  ItemTypeSchema,
  TenantConfigSchema,
  parseTenantConnectorConfig,
  TenantRetentionSettingsSchema,
  TenantLocaleSettingsSchema,
  normalizeCatalogText,
} from '@agentcore/shared';
import { assertSeedAllowed } from './persistence/seed-safety.js';
import { describe, expect, it } from 'vitest';

describe('shared persistence contracts', () => {
  it('rejects unknown tenant and connector configuration keys', () => {
    expect(
      TenantConfigSchema.safeParse({ tone: 'formal', secret: 'nope' }).success,
    ).toBe(false);
    expect(
      parseTenantConnectorConfig('generic-rest', {
        baseUrl: 'https://crm.example.com',
        accessToken: 'not-allowed',
      }).success,
    ).toBe(false);
    expect(parseTenantConnectorConfig('unregistered', {}).success).toBe(false);
    expect(
      TenantRetentionSettingsSchema.safeParse({ forever: true }).success,
    ).toBe(false);
  });

  it('validates strict JSON records while leaving pack-defined attribute names open', () => {
    expect(
      CatalogAttributesSchema.safeParse({
        fields: { customPackField: 'value' },
      }).success,
    ).toBe(true);
    expect(
      CatalogAttributesSchema.safeParse({ fields: {}, unrecognized: true })
        .success,
    ).toBe(false);
    expect(
      ConversationSlotsSchema.safeParse({
        version: 1,
        slots: {
          preferredTime: { value: 'evening', source: 'customer', extra: true },
        },
      }).success,
    ).toBe(false);
  });

  it('normalizes compatibility forms, case, apostrophes, and whitespace', () => {
    expect(normalizeCatalogText('  Oʻzbekiston   G‘uzor  ')).toBe(
      "o'zbekiston g'uzor",
    );
    expect(normalizeCatalogText('O‘zbekiston')).toBe(
      normalizeCatalogText("O'zbekiston"),
    );
  });

  it('accepts current ISO 4217 codes and rejects unknown alphabetic codes', () => {
    expect(CurrencyCodeSchema.safeParse('UZS').success).toBe(true);
    expect(CurrencyCodeSchema.safeParse('XXX').success).toBe(true);
    expect(CurrencyCodeSchema.safeParse('ZZZ').success).toBe(false);
    expect(CurrencyCodeSchema.safeParse('US').success).toBe(false);
  });

  it('validates extensible pack, item, slot, locale, and handover identifiers', () => {
    expect(DomainPackKeySchema.safeParse('travel-demo').success).toBe(true);
    expect(ItemTypeSchema.safeParse('catalog-item.v1').success).toBe(true);
    expect(ItemTypeSchema.safeParse('Course').success).toBe(false);
    expect(
      HandoverReasonCodeSchema.safeParse('CONNECTOR_UNAVAILABLE').success,
    ).toBe(true);
    expect(
      TenantLocaleSettingsSchema.safeParse({
        defaultLocale: 'uz-Latn',
        supportedLocales: ['uz-Latn', 'ru'],
      }).success,
    ).toBe(true);
    expect(
      TenantLocaleSettingsSchema.safeParse({
        defaultLocale: 'uz-Latn',
        supportedLocales: ['ru'],
      }).success,
    ).toBe(false);
  });

  it('refuses to run the development seed in production', () => {
    expect(() => assertSeedAllowed('production')).toThrow(
      'The development seed is disabled in production',
    );
    expect(() => assertSeedAllowed('test')).not.toThrow();
  });
});
