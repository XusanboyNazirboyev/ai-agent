/**
 * Price list upload (ADR 064): the fields a column can be mapped to, which
 * ones are required, and the `config` the API expects in its query.
 */

export const SHEET_FIELDS = [
  'code',
  'title',
  'destination',
  'hotel',
  'stars',
  'nights',
  'meal',
  'room',
  'departureDate',
  'departureCity',
  'price',
  'currency',
  'seats',
  'flight',
  'notes',
] as const;
export type SheetField = (typeof SHEET_FIELDS)[number];

/** Field -> index of the column in the header row. */
export type SheetMapping = Partial<Record<SheetField, number>>;

export interface SheetRowError {
  line: number;
  code: string;
  message: string;
  field?: SheetField;
}

export interface SheetPreview {
  delimiter: string;
  header: string[];
  suggestedMapping: SheetMapping;
  mapping: SheetMapping;
  missingFields: string[];
  rowCount: number;
  accepted: number;
  rejected: number;
  errors: SheetRowError[];
  errorsTruncated: boolean;
  sample: Array<{
    line: number;
    title: string;
    price: string;
    currency: string;
    departureDate: string | null;
    availability: 'AVAILABLE' | 'LIMITED' | 'SOLD_OUT' | 'UNKNOWN';
    seatsLeft: number | null;
  }>;
}

export interface SheetStatus {
  uploaded: boolean;
  name?: string;
  sourceFilename?: string | null;
  uploadedAt?: string;
  freshnessDays?: number;
  validUntil?: string;
  stale?: boolean;
  rowCount?: number;
  acceptedCount?: number;
  rejectedCount?: number;
  /** The shared Google Sheets link the list came from, and whether the server reloads it. */
  sourceUrl?: string | null;
  autoRefresh?: boolean;
  /** Error code of the last failed reload (the old list is still used). */
  refreshError?: string | null;
}

export interface SheetUploadResult {
  uploadedAt: string;
  accepted: number;
  rejected: number;
  catalogBound: boolean;
  boundTo: string | null;
}

/** The fields without which a price list cannot be imported. */
export function missingSheetFields(mapping: SheetMapping): SheetField[] {
  const missing: SheetField[] = [];
  if (mapping.price === undefined) missing.push('price');
  if (
    mapping.title === undefined &&
    mapping.destination === undefined &&
    mapping.hotel === undefined
  )
    missing.push('title');
  return missing;
}

export interface SheetSettings {
  /** Undefined: the server suggests the columns. */
  mapping?: SheetMapping;
  defaultCurrency: string;
  freshnessDays: number;
  /** A Google Sheets link the text was loaded from (kept for reloads). */
  sourceUrl?: string;
  autoRefresh?: boolean;
}

/** The JSON of the API's `config` query value; empty values are left out. */
export function sheetConfigQuery(settings: SheetSettings): string {
  let mapping: SheetMapping | undefined;
  if (settings.mapping) {
    mapping = {};
    for (const field of SHEET_FIELDS) {
      const index = settings.mapping[field];
      if (index !== undefined) mapping[field] = index;
    }
  }
  return JSON.stringify({
    ...(mapping ? { mapping } : {}),
    ...(settings.defaultCurrency
      ? { defaultCurrency: settings.defaultCurrency }
      : {}),
    freshnessDays: settings.freshnessDays,
    ...(settings.sourceUrl
      ? {
          sourceUrl: settings.sourceUrl,
          autoRefresh: settings.autoRefresh ?? false,
        }
      : {}),
  });
}

/** Sets or clears one field; a column is used by one field only (the old owner loses it). */
export function withMapping(
  mapping: SheetMapping,
  field: SheetField,
  column: number | null,
): SheetMapping {
  const next: SheetMapping = {};
  for (const key of SHEET_FIELDS) {
    const index = mapping[key];
    if (key === field || index === undefined) continue;
    if (column !== null && index === column) continue;
    next[key] = index;
  }
  if (column !== null) next[field] = column;
  return next;
}
