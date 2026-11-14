import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { PrismaService } from '../../persistence/prisma.service.js';
import { SHEET_CURRENCIES } from './cell-values.js';
import { parseSheet, type ParsedSheet } from './csv-reader.js';
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
  })
  .strict();
export type SheetConfig = z.infer<typeof SheetConfigSchema>;

export class SheetCatalogError extends Error {
  constructor(
    readonly code:
      | 'SHEET_MAPPING_INCOMPLETE'
      | 'SHEET_NO_VALID_ROWS'
      | 'SHEET_NO_ROWS'
      | 'SHEET_COLUMN_OUT_OF_RANGE',
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
  constructor(
    private readonly prisma: PrismaService,
    private readonly store: PrismaSheetCatalogStore,
  ) {}

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
    const { mapping, result } = this.read(csv, config);
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
