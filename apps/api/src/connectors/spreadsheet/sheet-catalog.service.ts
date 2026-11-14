import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { z } from 'zod';
import { PrismaService } from '../../persistence/prisma.service.js';
import { SHEET_CURRENCIES } from './cell-values.js';
import { parseSheet, SheetReadError, type ParsedSheet } from './csv-reader.js';
import {
  FIELD_KEYS,
  missingRequiredFields,
  suggestMapping,
  type ColumnMapping,
} from './field-suggest.js';
import {
  mapSheet,
  type MapOptions,
  type MappedOffer,
  type RowError,
  type SheetMapResult,
} from './row-mapper.js';
import {
  PrismaSheetCatalogStore,
  type SheetCatalogMeta,
} from './sheet-catalog.store.js';
import { SPREADSHEET_CONNECTOR_KEY } from './spreadsheet-connector.js';
import {
  fetchSheetCsv,
  SheetFetchError,
  type SheetFetchOptions,
} from './google-sheet-fetch.js';
import { parseGoogleSheetLink } from './google-sheet-link.js';

/** DI token of the fetch settings (the e2e points them at a fake Google). */
export const SHEET_FETCH_OPTIONS = 'SHEET_FETCH_OPTIONS';
/** An auto-refreshed list is reloaded when its data is this old. */
export const SHEET_REFRESH_EVERY_MS = 6 * 3_600_000;
/** After a failed attempt the next one waits this long. */
export const SHEET_REFRESH_RETRY_MS = 3_600_000;

const DAY_MS = 86_400_000;
export const SHEET_PREVIEW_ERRORS = 100;
export const SHEET_PREVIEW_SAMPLE = 10;

/** What the admin sends along with the file (JSON in the `config` query value). */
export const SheetConfigSchema = z
  .object({
    mapping: z
      .object(
        Object.fromEntries(
          FIELD_KEYS.map((key) => [
            key,
            z.number().int().min(0).max(59).optional(),
          ]),
        ) as Record<(typeof FIELD_KEYS)[number], z.ZodOptional<z.ZodNumber>>,
      )
      .strict()
      .optional(),
    defaultCurrency: z.enum(SHEET_CURRENCIES).optional(),
    limitedThreshold: z.number().int().min(0).max(50).optional(),
    defaultAvailability: z.enum(['AVAILABLE', 'UNKNOWN']).optional(),
    freshnessDays: z.number().int().min(1).max(30).optional(),
    name: z.string().trim().min(1).max(120).optional(),
    /** Bind the CATALOG role to the price list when nothing is bound yet (default true). */
    bindCatalog: z.boolean().optional(),
    /** A shared Google Sheets link the file text came from (kept for refresh). */
    sourceUrl: z.string().trim().max(500).optional(),
    /** Reload the link by itself every few hours (needs `sourceUrl`). */
    autoRefresh: z.boolean().optional(),
  })
  .strict();
export type SheetConfig = z.infer<typeof SheetConfigSchema>;

export class SheetCatalogError extends Error {
  constructor(
    readonly code:
      | 'SHEET_MAPPING_INCOMPLETE'
      | 'SHEET_NO_VALID_ROWS'
      | 'SHEET_NO_ROWS'
      | 'SHEET_COLUMN_OUT_OF_RANGE'
      | 'SHEET_LINK_INVALID'
      | 'SHEET_NO_LINK'
      | 'SHEET_COLUMNS_CHANGED',
    message: string,
  ) {
    super(message);
    this.name = 'SheetCatalogError';
  }
}

export interface SheetPreview {
  readonly delimiter: string;
  readonly header: readonly string[];
  readonly suggestedMapping: ColumnMapping;
  readonly mapping: ColumnMapping;
  readonly missingFields: readonly string[];
  readonly rowCount: number;
  readonly accepted: number;
  readonly rejected: number;
  readonly errors: readonly RowError[];
  readonly errorsTruncated: boolean;
  readonly sample: ReadonlyArray<{
    line: number;
    title: string;
    price: string;
    currency: string;
    departureDate: string | null;
    availability: MappedOffer['availability'];
    seatsLeft: number | null;
  }>;
}

export interface SheetStatus {
  readonly uploaded: boolean;
  readonly name?: string;
  readonly sourceFilename?: string | null;
  readonly uploadedAt?: string;
  readonly freshnessDays?: number;
  /** When prices stop being quoted. */
  readonly validUntil?: string;
  readonly stale?: boolean;
  readonly rowCount?: number;
  readonly acceptedCount?: number;
  readonly rejectedCount?: number;
  readonly mapping?: ColumnMapping;
  /** The shared link the list was loaded from, and whether the server reloads it. */
  readonly sourceUrl?: string | null;
  readonly autoRefresh?: boolean;
  /** Why the last reload kept the old list (a code), when it did. */
  readonly refreshError?: string | null;
}

/** The reason code of a failed reload; anything unexpected is a generic one. */
function codeOf(error: unknown): string {
  return error instanceof SheetFetchError ||
    error instanceof SheetCatalogError ||
    error instanceof SheetReadError
    ? error.code
    : 'SHEET_REFRESH_FAILED';
}

function checkMapping(mapping: ColumnMapping, columns: number): void {
  for (const index of Object.values(mapping))
    if (index !== undefined && index >= columns)
      throw new SheetCatalogError(
        'SHEET_COLUMN_OUT_OF_RANGE',
        `A mapped column (${index + 1}) is not in the file`,
      );
}

function optionsOf(config: SheetConfig): MapOptions {
  return {
    ...(config.defaultCurrency
      ? { defaultCurrency: config.defaultCurrency }
      : {}),
    ...(config.limitedThreshold !== undefined
      ? { limitedThreshold: config.limitedThreshold }
      : {}),
    ...(config.defaultAvailability
      ? { defaultAvailability: config.defaultAvailability }
      : {}),
  };
}

/**
 * Upload of a price list (ADR 064): `preview` reads and maps the file without
 * saving anything; `commit` saves it as the tenant's catalog, makes sure the
 * `spreadsheet` connector exists and, when nothing serves the CATALOG role
 * yet, binds it. Tenant and actor come from the session, never from the body.
 */
@Injectable()
export class SheetCatalogService {
  private readonly logger = new Logger(SheetCatalogService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly store: PrismaSheetCatalogStore,
    @Optional()
    @Inject(SHEET_FETCH_OPTIONS)
    private readonly fetchOptions: SheetFetchOptions = {},
  ) {}

  /**
   * Reads a shared Google Sheets link on the server (a browser may not call
   * Google: no CORS). Returns the CSV text and the normalised link; the admin
   * then checks the columns and saves like for a file.
   */
  async fetchFromLink(
    link: string,
  ): Promise<{ csv: string; sourceUrl: string }> {
    const ref = parseGoogleSheetLink(link);
    if (!ref)
      throw new SheetCatalogError(
        'SHEET_LINK_INVALID',
        'This is not a Google Sheets link',
      );
    const csv = await fetchSheetCsv(ref, this.fetchOptions);
    return { csv, sourceUrl: ref.canonicalUrl };
  }

  /** Header text of each mapped column, the guard against moved columns. */
  private headersOf(
    sheet: ParsedSheet,
    mapping: ColumnMapping,
  ): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [field, index] of Object.entries(mapping))
      if (index !== undefined) out[field] = (sheet.header[index] ?? '').trim();
    return out;
  }

  /**
   * Reloads the saved link with the saved mapping. The old list stays when
   * anything is wrong (the link, the file, moved columns, no valid row); it
   * then ages out by itself and the agent stops quoting it.
   */
  async refresh(
    tenantId: string,
    actor: { operatorId: string } | null,
    now: Date = new Date(),
  ): Promise<{ accepted: number; rejected: number }> {
    const meta = await this.store.meta(tenantId);
    if (!meta?.sourceUrl)
      throw new SheetCatalogError('SHEET_NO_LINK', 'No link is saved');
    const fail = async (error: unknown): Promise<never> => {
      await this.store.markRefreshFailed(tenantId, codeOf(error), now);
      throw error;
    };
    try {
      const ref = parseGoogleSheetLink(meta.sourceUrl);
      if (!ref)
        throw new SheetCatalogError(
          'SHEET_LINK_INVALID',
          'The saved link is not valid',
        );
      const csv = await fetchSheetCsv(ref, this.fetchOptions);
      const sheet = parseSheet(csv);
      // A column inserted before the price would silently make the price the
      // wrong column: every mapped header must still be where it was.
      const expected = meta.mappedHeaders;
      for (const [field, index] of Object.entries(meta.mapping))
        if (
          index !== undefined &&
          (sheet.header[index] ?? '').trim() !== (expected[field] ?? '')
        )
          throw new SheetCatalogError(
            'SHEET_COLUMNS_CHANGED',
            'The columns of the sheet moved',
          );
      const result = mapSheet(sheet, meta.mapping, meta.options);
      if (result.offers.length === 0)
        throw new SheetCatalogError(
          'SHEET_NO_VALID_ROWS',
          'No row of the sheet could be read',
        );
      await this.store.replace(tenantId, {
        name: meta.name,
        sourceFilename: meta.sourceFilename,
        mapping: meta.mapping,
        options: meta.options,
        freshnessDays: meta.freshnessDays,
        uploadedAt: now,
        result,
        sourceUrl: meta.sourceUrl,
        autoRefresh: meta.autoRefresh,
        mappedHeaders: expected,
      });
      await this.prisma.auditEvent.create({
        data: {
          tenantId,
          actorType: actor ? 'OPERATOR' : 'SYSTEM',
          actorId: actor?.operatorId ?? null,
          action: 'catalog.sheet.refreshed',
          entityType: 'sheet_catalog',
          entityId: meta.id,
          // Counts only: never a cell, a hotel name or a price.
          safeInputSummary: {
            rows: result.rowCount,
            accepted: result.offers.length,
            rejected: result.errors.length,
          },
        },
      });
      return { accepted: result.offers.length, rejected: result.errors.length };
    } catch (error) {
      return fail(error);
    }
  }

  /**
   * The periodic scan: reloads every auto-refreshed list whose data is older
   * than the interval, one attempt per list per retry window, claimed so that
   * several API processes never fetch the same list twice.
   */
  async scanDue(now: Date, limit = 10): Promise<number> {
    const due = await this.store.dueForRefresh(
      new Date(now.getTime() - SHEET_REFRESH_EVERY_MS),
      new Date(now.getTime() - SHEET_REFRESH_RETRY_MS),
      limit,
    );
    let refreshed = 0;
    for (const item of due) {
      const claimed = await this.store.claimRefresh(
        item.tenantId,
        item.id,
        now,
        new Date(now.getTime() - SHEET_REFRESH_RETRY_MS),
      );
      if (!claimed) continue;
      try {
        await this.refresh(item.tenantId, null, now);
        refreshed += 1;
      } catch (error) {
        this.logger.warn(
          JSON.stringify({
            event: 'sheet_catalog.refresh_failed',
            tenant: item.tenantId,
            code: codeOf(error),
          }),
        );
      }
    }
    return refreshed;
  }

  /** Throws SheetReadError for an unreadable file. */
  private read(
    csv: string,
    config: SheetConfig,
  ): { sheet: ParsedSheet; mapping: ColumnMapping; result: SheetMapResult } {
    const sheet = parseSheet(csv);
    const mapping = config.mapping ?? suggestMapping(sheet.header);
    checkMapping(mapping, sheet.header.length);
    if (sheet.rows.length === 0)
      throw new SheetCatalogError(
        'SHEET_NO_ROWS',
        'The file has a header but no rows',
      );
    return {
      sheet,
      mapping,
      result: mapSheet(sheet, mapping, optionsOf(config)),
    };
  }

  preview(csv: string, config: SheetConfig = {}): SheetPreview {
    const { sheet, mapping, result } = this.read(csv, config);
    const itemTitle = new Map(
      result.items.map((item) => [item.key, item.title]),
    );
    return {
      delimiter: sheet.delimiter,
      header: sheet.header,
      suggestedMapping: suggestMapping(sheet.header),
      mapping,
      missingFields: missingRequiredFields(mapping),
      rowCount: result.rowCount,
      accepted: result.offers.length,
      rejected: result.errors.length,
      errors: result.errors.slice(0, SHEET_PREVIEW_ERRORS),
      errorsTruncated: result.errors.length > SHEET_PREVIEW_ERRORS,
      sample: result.offers.slice(0, SHEET_PREVIEW_SAMPLE).map((offer) => ({
        line: offer.line,
        title: itemTitle.get(offer.itemKey) ?? '',
        price: offer.price.amount,
        currency: offer.price.currency,
        departureDate: offer.startsOn ?? null,
        availability: offer.availability,
        seatsLeft: offer.seatsLeft ?? null,
      })),
    };
  }

  async commit(
    actor: { tenantId: string; operatorId: string },
    csv: string,
    config: SheetConfig,
    filename: string | null,
    now: Date = new Date(),
  ): Promise<{
    meta: SheetCatalogMeta;
    rejected: number;
    catalogBound: boolean;
    boundTo: string | null;
  }> {
    const { sheet, mapping, result } = this.read(csv, config);
    // A link is kept only in its canonical form (read from the pasted text again here).
    const link = config.sourceUrl
      ? parseGoogleSheetLink(config.sourceUrl)
      : null;
    if (config.sourceUrl && !link)
      throw new SheetCatalogError(
        'SHEET_LINK_INVALID',
        'This is not a Google Sheets link',
      );
    const missing = missingRequiredFields(mapping);
    if (missing.length > 0)
      throw new SheetCatalogError(
        'SHEET_MAPPING_INCOMPLETE',
        `Map the column for: ${missing.join(', ')}`,
      );
    if (result.offers.length === 0)
      throw new SheetCatalogError(
        'SHEET_NO_VALID_ROWS',
        'No row of the file could be read; nothing was saved',
      );
    const meta = await this.store.replace(actor.tenantId, {
      name: config.name ?? 'Price list',
      sourceFilename: filename,
      mapping,
      options: optionsOf(config),
      freshnessDays: config.freshnessDays ?? 3,
      uploadedAt: now,
      result,
      sourceUrl: link?.canonicalUrl ?? null,
      autoRefresh: link ? (config.autoRefresh ?? false) : false,
      mappedHeaders: this.headersOf(sheet, mapping),
    });
    const binding = await this.ensureConnector(
      actor,
      config.bindCatalog ?? true,
    );
    await this.prisma.auditEvent.create({
      data: {
        tenantId: actor.tenantId,
        actorType: 'OPERATOR',
        actorId: actor.operatorId,
        action: 'catalog.sheet.uploaded',
        entityType: 'sheet_catalog',
        entityId: meta.id,
        // Counts only: never a cell, a hotel name or a price.
        safeInputSummary: {
          rows: result.rowCount,
          accepted: result.offers.length,
          rejected: result.errors.length,
          catalogBound: binding.catalogBound,
        },
      },
    });
    return {
      meta,
      rejected: result.errors.length,
      catalogBound: binding.catalogBound,
      boundTo: binding.boundTo,
    };
  }

  async status(tenantId: string, now: Date = new Date()): Promise<SheetStatus> {
    const meta = await this.store.meta(tenantId);
    if (!meta) return { uploaded: false };
    const validUntil = new Date(
      meta.uploadedAt.getTime() + meta.freshnessDays * DAY_MS,
    );
    return {
      uploaded: true,
      name: meta.name,
      sourceFilename: meta.sourceFilename,
      uploadedAt: meta.uploadedAt.toISOString(),
      freshnessDays: meta.freshnessDays,
      validUntil: validUntil.toISOString(),
      stale: now.getTime() > validUntil.getTime(),
      rowCount: meta.rowCount,
      acceptedCount: meta.acceptedCount,
      rejectedCount: meta.rejectedCount,
      mapping: meta.mapping,
      sourceUrl: meta.sourceUrl,
      autoRefresh: meta.autoRefresh,
      refreshError: meta.refreshError,
    };
  }

  /**
   * The `spreadsheet` connector row of the tenant (created on first upload,
   * active) and, only when the CATALOG role has no connector yet, the binding.
   * An existing binding to another connector is never replaced silently.
   */
  private async ensureConnector(
    actor: { tenantId: string },
    bind: boolean,
  ): Promise<{ catalogBound: boolean; boundTo: string | null }> {
    const { tenantId } = actor;
    const connector = await this.prisma.tenantConnector.upsert({
      where: {
        tenantId_connectorKey: {
          tenantId,
          connectorKey: SPREADSHEET_CONNECTOR_KEY,
        },
      },
      create: {
        tenantId,
        connectorKey: SPREADSHEET_CONNECTOR_KEY,
        status: 'ACTIVE',
        config: {},
      },
      update: { status: 'ACTIVE' },
      select: { id: true },
    });
    const bound = await this.prisma.tenantConnectorRole.findFirst({
      where: { tenantId, role: 'CATALOG' },
      include: { connector: { select: { connectorKey: true } } },
    });
    if (bound)
      return {
        catalogBound: bound.tenantConnectorId === connector.id,
        boundTo: bound.connector.connectorKey,
      };
    if (!bind) return { catalogBound: false, boundTo: null };
    await this.prisma.tenantConnectorRole.create({
      data: { tenantId, role: 'CATALOG', tenantConnectorId: connector.id },
    });
    return { catalogBound: true, boundTo: SPREADSHEET_CONNECTOR_KEY };
  }
}
