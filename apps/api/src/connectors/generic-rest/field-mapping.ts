import { CurrencyCodeSchema } from '@agentcore/shared';
import { z } from 'zod';
import type { Money } from '../contracts/canonical.js';
import { ConnectorInvalidResponseError } from '../interfaces/errors.js';
import { getByPath } from './rest-config.js';

const DECIMAL = /^-?\d+(?:\.\d+)?$/;
const DateTimeSchema = z.iso.datetime({ offset: true });
const JsonRecordSchema = z.record(z.string(), z.json());
const JsonValueSchema = z.json();
export type JsonValue = z.infer<typeof JsonValueSchema>;
// Matches the source_entity_id column width.
const MAX_IDENTIFIER_LENGTH = 200;

/**
 * Reads typed canonical fields from one upstream record.
 *
 * Each field is read from its mapped path (or the canonical default paths)
 * and type-checked. A value that is present but has the wrong type is an
 * invalid response: it is never coerced into something the source did not
 * say (`"[object Object]"`, `NaN`, a fallback id from another field).
 * Errors name the entity and canonical field, never the value, because
 * upstream values may contain customer data.
 */
export class RecordReader {
  constructor(
    private readonly record: unknown,
    private readonly entity: string,
    private readonly source: string,
  ) {}

  private invalid(field: string, reason: string): never {
    throw new ConnectorInvalidResponseError({
      message: `Connector ${this.entity}.${field} ${reason}`,
      code: 'CONNECTOR_INVALID_FIELD',
      source: this.source,
    });
  }

  /** First non-null value among the candidate paths. */
  private read(paths: readonly string[]): unknown {
    for (const path of paths) {
      const value = getByPath(this.record, path);
      if (value !== undefined && value !== null) return value;
    }
    return undefined;
  }

  identifier(field: string, paths: readonly string[]): string {
    const value = this.optionalIdentifier(field, paths);
    if (value === undefined) this.invalid(field, 'is missing');
    return value;
  }

  optionalIdentifier(
    field: string,
    paths: readonly string[],
  ): string | undefined {
    const raw = this.read(paths);
    if (raw === undefined) return undefined;
    if (typeof raw === 'number' && Number.isSafeInteger(raw)) {
      return String(raw);
    }
    if (typeof raw === 'string') {
      const value = raw.trim();
      if (
        value.length > 0 &&
        value.length <= MAX_IDENTIFIER_LENGTH &&
        // eslint-disable-next-line no-control-regex
        !/[\u0000-\u001f\u007f]/.test(value)
      ) {
        return value;
      }
    }
    return this.invalid(field, 'is not a valid identifier');
  }

  text(
    field: string,
    paths: readonly string[],
    options: { required: true; max: number },
  ): string;
  text(
    field: string,
    paths: readonly string[],
    options: { required?: false; max: number },
  ): string | undefined;
  text(
    field: string,
    paths: readonly string[],
    options: { required?: boolean; max: number },
  ): string | undefined {
    const raw = this.read(paths);
    if (raw === undefined) {
      if (options.required) this.invalid(field, 'is missing');
      return undefined;
    }
    if (typeof raw !== 'string') return this.invalid(field, 'is not text');
    const value = raw.trim();
    if (value.length === 0) {
      if (options.required) this.invalid(field, 'is empty');
      return undefined;
    }
    if (value.length > options.max) {
      return this.invalid(field, `exceeds ${options.max} characters`);
    }
    return value;
  }

  nonNegativeInteger(
    field: string,
    paths: readonly string[],
  ): number | undefined {
    const raw = this.read(paths);
    if (raw === undefined) return undefined;
    if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0) {
      return raw;
    }
    if (typeof raw === 'string' && /^\d{1,15}$/.test(raw.trim())) {
      return Number(raw.trim());
    }
    return this.invalid(field, 'is not a non-negative integer');
  }

  boolean(field: string, paths: readonly string[]): boolean | undefined {
    const raw = this.read(paths);
    if (raw === undefined) return undefined;
    if (typeof raw === 'boolean') return raw;
    return this.invalid(field, 'is not a boolean');
  }

  dateTime(field: string, paths: readonly string[]): string | undefined {
    const raw = this.read(paths);
    if (raw === undefined) return undefined;
    if (typeof raw === 'string' && DateTimeSchema.safeParse(raw).success) {
      return raw;
    }
    return this.invalid(field, 'is not an ISO 8601 date-time with offset');
  }

  /**
   * Exact money. Both parts absent means "no price"; one part alone is an
   * invalid response. Numbers are accepted only when their decimal rendering
   * is exact (no exponent form), so 1e21 or NaN can never become a price.
   */
  money(
    field: string,
    amountPaths: readonly string[],
    currencyPaths: readonly string[],
  ): Money | undefined {
    const amountRaw = this.read(amountPaths);
    const currencyRaw = this.read(currencyPaths);
    if (amountRaw === undefined && currencyRaw === undefined) return undefined;
    if (amountRaw === undefined || currencyRaw === undefined) {
      return this.invalid(field, 'needs both amount and currency');
    }

    let amount: string | undefined;
    if (typeof amountRaw === 'string' && DECIMAL.test(amountRaw.trim())) {
      amount = amountRaw.trim();
    } else if (
      typeof amountRaw === 'number' &&
      Number.isFinite(amountRaw) &&
      DECIMAL.test(String(amountRaw))
    ) {
      amount = String(amountRaw);
    }
    if (amount === undefined) {
      return this.invalid(field, 'amount is not an exact decimal');
    }

    const currency =
      typeof currencyRaw === 'string'
        ? CurrencyCodeSchema.safeParse(currencyRaw.trim().toUpperCase())
        : undefined;
    if (!currency?.success) {
      return this.invalid(field, 'currency is not an ISO 4217 code');
    }
    return { amount, currency: currency.data };
  }

  /** Maps a text value through `map`; absent or unrecognised -> `fallback`. */
  enumValue<T extends string>(
    field: string,
    paths: readonly string[],
    map: (normalized: string) => T | undefined,
    fallback: T,
  ): T {
    const raw = this.read(paths);
    if (raw === undefined) return fallback;
    if (typeof raw !== 'string') return this.invalid(field, 'is not text');
    return (
      map(
        raw
          .trim()
          .toUpperCase()
          .replace(/[\s-]+/g, '_'),
      ) ?? fallback
    );
  }

  jsonRecord(
    field: string,
    paths: readonly string[],
  ): Record<string, JsonValue> | undefined {
    const raw = this.read(paths);
    if (raw === undefined) return undefined;
    const parsed =
      typeof raw === 'object' && !Array.isArray(raw)
        ? JsonRecordSchema.safeParse(raw)
        : undefined;
    if (!parsed?.success) return this.invalid(field, 'is not a JSON object');
    return parsed.data;
  }

  /** Copies only the explicitly mapped attributes. */
  attributes(
    mapping: Readonly<Record<string, string>> | undefined,
  ): Record<string, JsonValue> {
    const attributes: Record<string, JsonValue> = {};
    for (const [name, path] of Object.entries(mapping ?? {})) {
      const raw = getByPath(this.record, path);
      if (raw === undefined) continue;
      const parsed = JsonValueSchema.safeParse(raw);
      if (!parsed.success) {
        this.invalid(`attributes.${name}`, 'is not JSON');
      }
      attributes[name] = parsed.data;
    }
    return attributes;
  }
}
