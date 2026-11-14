import { createHash } from 'node:crypto';
import {
  addDays,
  currencyInAmountCell,
  normalizeMeal,
  normalizeRoom,
  parseAmount,
  parseCount,
  parseCurrency,
  parseDate,
  parseYesNo,
  type SheetCurrency,
} from './cell-values.js';
import type { ParsedSheet } from './csv-reader.js';
import {
  missingRequiredFields,
  type ColumnMapping,
  type FieldKey,
} from './field-suggest.js';

/**
 * Turns the rows of an uploaded price list into canonical items and offers
 * (ADR 064 decisions 3 and 4). A row that cannot be read with confidence is
 * rejected with its line number and reason; nothing is guessed.
 */

export type AvailabilityStatus =
  'AVAILABLE' | 'LIMITED' | 'SOLD_OUT' | 'UNKNOWN';
type Attribute = string | number | boolean;

export interface MapOptions {
  /** Used when a row has no currency of its own. */
  readonly defaultCurrency?: SheetCurrency;
  /** Seats left at or below this count (and above 0) read as `LIMITED`. */
  readonly limitedThreshold?: number;
  /** Availability of a row when the sheet has no seats column. */
  readonly defaultAvailability?: 'AVAILABLE' | 'UNKNOWN';
  readonly itemType?: string;
}

export interface MappedItem {
  readonly key: string;
  readonly title: string;
  readonly itemType: string;
  readonly attributes: Readonly<Record<string, Attribute>>;
}

export interface MappedOffer {
  readonly key: string;
  /** Key of the item this departure belongs to. */
  readonly itemKey: string;
  readonly line: number;
  readonly price: { readonly amount: string; readonly currency: SheetCurrency };
  readonly pricingBasis: 'PER_PERSON';
  readonly availability: AvailabilityStatus;
  readonly seatsLeft?: number;
  /** `YYYY-MM-DD`; the connector turns it into an instant in the tenant's time zone. */
  readonly startsOn?: string;
  readonly endsOn?: string;
  readonly attributes: Readonly<Record<string, Attribute>>;
}

export type RowErrorCode =
  | 'MAPPING_INCOMPLETE'
  | 'TITLE_MISSING'
  | 'PRICE_INVALID'
  | 'CURRENCY_UNKNOWN'
  | 'DATE_INVALID'
  | 'NIGHTS_INVALID'
  | 'STARS_INVALID'
  | 'SEATS_INVALID'
  | 'DUPLICATE_KEY';

export interface RowError {
  /** 1-based line in the file (1 is the header). */
  readonly line: number;
  readonly code: RowErrorCode;
  readonly message: string;
  /** The mapped field the problem is about. */
  readonly field?: FieldKey;
}

export interface SheetMapResult {
  readonly items: readonly MappedItem[];
  readonly offers: readonly MappedOffer[];
  readonly errors: readonly RowError[];
  /** Rows read (data lines, blank lines excluded). */
  readonly rowCount: number;
}

function hashKey(parts: readonly string[]): string {
  return createHash('sha256')
    .update(parts.map((part) => part.trim().toLowerCase()).join('|'))
    .digest('hex')
    .slice(0, 16);
}

export function mapSheet(
  sheet: ParsedSheet,
  mapping: ColumnMapping,
  options: MapOptions = {},
): SheetMapResult {
  const missing = missingRequiredFields(mapping);
  if (missing.length > 0)
    return {
      items: [],
      offers: [],
      rowCount: sheet.rows.length,
      errors: [
        {
          line: 1,
          code: 'MAPPING_INCOMPLETE',
          message: `Map the column for: ${missing.join(', ')}`,
        },
      ],
    };
  const limited = options.limitedThreshold ?? 3;
  const items = new Map<string, MappedItem>();
  const offers: MappedOffer[] = [];
  const errors: RowError[] = [];
  const seenOffers = new Set<string>();

  for (const row of sheet.rows) {
    const cell = (field: FieldKey): string => {
      const index = mapping[field];
      return index === undefined ? '' : (row.cells[index] ?? '').trim();
    };
    const problems: RowError[] = [];
    const fail = (
      code: RowErrorCode,
      message: string,
      field?: FieldKey,
    ): void => {
      problems.push({ line: row.line, code, message, field });
    };

    // Price and currency.
    const priceText = cell('price');
    const amount = parseAmount(priceText);
    if (amount === null)
      fail('PRICE_INVALID', `The price "${priceText}" cannot be read`, 'price');
    const currencyText = cell('currency');
    const currency: SheetCurrency | null =
      (currencyText !== '' ? parseCurrency(currencyText) : null) ??
      (currencyText === '' ? currencyInAmountCell(priceText) : null) ??
      (currencyText === '' ? (options.defaultCurrency ?? null) : null);
    if (currency === null)
      fail(
        'CURRENCY_UNKNOWN',
        currencyText === ''
          ? 'The row has no currency'
          : `The currency "${currencyText}" is not known`,
        'currency',
      );

    // Date, nights, stars, seats.
    let startsOn: string | undefined;
    const dateText = cell('departureDate');
    if (mapping.departureDate !== undefined) {
      const date = parseDate(dateText);
      if (date === null)
        fail(
          'DATE_INVALID',
          `The date "${dateText}" cannot be read`,
          'departureDate',
        );
      else startsOn = date;
    }
    let nights: number | undefined;
    if (cell('nights') !== '') {
      const parsed = parseCount(cell('nights'));
      if (parsed === null || parsed < 1 || parsed > 365)
        fail(
          'NIGHTS_INVALID',
          `The nights "${cell('nights')}" are not a number`,
          'nights',
        );
      else nights = parsed;
    }
    let stars: number | undefined;
    if (cell('stars') !== '') {
      const parsed = parseCount(cell('stars').replace(/[*★]/gu, ''));
      if (parsed === null || parsed > 7)
        fail(
          'STARS_INVALID',
          `The stars "${cell('stars')}" are not a number`,
          'stars',
        );
      else stars = parsed;
    }
    let seatsLeft: number | undefined;
    let availability: AvailabilityStatus =
      options.defaultAvailability ?? 'UNKNOWN';
    if (mapping.seats !== undefined && cell('seats') !== '') {
      const parsed = parseCount(cell('seats'));
      if (parsed === null)
        fail(
          'SEATS_INVALID',
          `The seats "${cell('seats')}" are not a number`,
          'seats',
        );
      else {
        seatsLeft = parsed;
        availability =
          parsed === 0
            ? 'SOLD_OUT'
            : parsed <= limited
              ? 'LIMITED'
              : 'AVAILABLE';
      }
    } else if (mapping.seats !== undefined) availability = 'UNKNOWN';

    // Title.
    const destination = cell('destination');
    const hotel = cell('hotel');
    const meal = cell('meal') === '' ? '' : normalizeMeal(cell('meal'));
    const room = cell('room') === '' ? '' : normalizeRoom(cell('room'));
    let title = cell('title');
    if (title === '') {
      const place = [
        destination,
        hotel !== '' ? `${hotel}${stars ? ` ${stars}★` : ''}` : '',
      ]
        .filter((part) => part !== '')
        .join(' · ');
      title = [place, nights ? `${nights} nights` : '', meal]
        .filter((part) => part !== '')
        .join(' · ');
    }
    if (title === '')
      fail('TITLE_MISSING', 'The row has no tour or hotel name');

    if (problems.length > 0 || amount === null || currency === null) {
      errors.push(...problems);
      continue;
    }

    const itemKey = hashKey([
      title,
      destination,
      hotel,
      String(nights ?? ''),
      meal,
    ]);
    const code = cell('code');
    const offerKey =
      code !== ''
        ? code
        : hashKey([itemKey, room, startsOn ?? '', cell('departureCity')]);
    if (seenOffers.has(offerKey)) {
      errors.push({
        line: row.line,
        code: 'DUPLICATE_KEY',
        message: `The key "${offerKey}" was already used by an earlier row`,
        field: code !== '' ? 'code' : undefined,
      });
      continue;
    }
    seenOffers.add(offerKey);

    if (!items.has(itemKey)) {
      const attributes: Record<string, Attribute> = {};
      if (destination !== '') attributes.destination = destination;
      if (hotel !== '') attributes.hotel = hotel;
      if (stars !== undefined) attributes.stars = stars;
      if (nights !== undefined) attributes.nights = nights;
      if (meal !== '') attributes.meal = meal;
      items.set(itemKey, {
        key: itemKey,
        title,
        itemType: options.itemType ?? 'tour',
        attributes,
      });
    }
    const offerAttributes: Record<string, Attribute> = {};
    if (room !== '') offerAttributes.room = room;
    if (cell('departureCity') !== '')
      offerAttributes.departureCity = cell('departureCity');
    if (cell('flight') !== '') {
      const flight = parseYesNo(cell('flight'));
      offerAttributes.flightIncluded = flight ?? cell('flight');
    }
    if (cell('notes') !== '') offerAttributes.notes = cell('notes');
    offers.push({
      key: offerKey,
      itemKey,
      line: row.line,
      price: { amount, currency },
      pricingBasis: 'PER_PERSON',
      availability,
      ...(seatsLeft !== undefined ? { seatsLeft } : {}),
      ...(startsOn !== undefined ? { startsOn } : {}),
      ...(startsOn !== undefined && nights !== undefined
        ? { endsOn: addDays(startsOn, nights) }
        : {}),
      attributes: offerAttributes,
    });
  }
  return {
    items: [...items.values()],
    offers,
    errors,
    rowCount: sheet.rows.length,
  };
}
