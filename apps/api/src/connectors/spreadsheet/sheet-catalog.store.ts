import { Prisma } from '../../generated/prisma/client.js';
import type { PrismaService } from '../../persistence/prisma.service.js';
import type { ColumnMapping } from './field-suggest.js';
import type { MapOptions, SheetMapResult } from './row-mapper.js';

/** What the connector and the upload service need from the stored price list (ADR 064). */

export interface SheetCatalogMeta {
  readonly id: string;
  readonly name: string;
  readonly sourceFilename: string | null;
  readonly uploadedAt: Date;
  readonly freshnessDays: number;
  readonly rowCount: number;
  readonly acceptedCount: number;
  readonly rejectedCount: number;
  readonly mapping: ColumnMapping;
  readonly options: MapOptions;
  /** IANA time zone of the tenant, for the local start of a departure day. */
  readonly timeZone: string;
}

export interface StoredItem {
  readonly key: string;
  readonly title: string;
  readonly itemType: string;
  readonly attributes: Readonly<Record<string, unknown>>;
}

export interface StoredOffer {
  readonly key: string;
  readonly itemKey: string;
  /** Decimal string without trailing zeros. */
  readonly price: string;
  readonly currency: string;
  readonly availability: 'AVAILABLE' | 'LIMITED' | 'SOLD_OUT' | 'UNKNOWN';
  readonly seatsLeft: number | null;
  readonly startsOn: string | null;
  readonly endsOn: string | null;
  readonly attributes: Readonly<Record<string, unknown>>;
}

export interface SheetSearch {
  readonly itemType?: string;
  readonly title?: string;
  readonly attributes?: Readonly<Record<string, unknown>>;
  readonly limit: number;
  readonly offset: number;
}

export interface SheetCatalogReader {
  meta(tenantId: string): Promise<SheetCatalogMeta | null>;
  searchItems(tenantId: string, query: SheetSearch): Promise<StoredItem[]>;
  getItem(tenantId: string, key: string): Promise<StoredItem | null>;
  getOffers(tenantId: string, itemKey: string): Promise<StoredOffer[]>;
  getOffer(tenantId: string, key: string): Promise<StoredOffer | null>;
}

export interface SheetCatalogInput {
  readonly name: string;
  readonly sourceFilename: string | null;
  readonly mapping: ColumnMapping;
  readonly options: MapOptions;
  readonly freshnessDays: number;
  readonly uploadedAt: Date;
  readonly result: SheetMapResult;
}

/** Lower case, single spaces: the form used to match a title query. */
export function normalizeTitle(text: string): string {
  return text.toLowerCase().replace(/\s+/gu, ' ').trim().slice(0, 600);
}

const MAX_SEARCH_WORDS = 8;
const MIN_WORD_LENGTH = 3;

/**
 * The words of a customer's phrase that are worth matching, each already
 * escaped for LIKE (a `%` or `_` typed by a customer is text, not a pattern).
 * Short words ("5", "in") are dropped unless nothing else is left, then the
 * whole phrase is matched as one piece, as before.
 */
export function searchWords(title: string | undefined): string[] {
  if (!title) return [];
  const text = normalizeTitle(title);
  const escape = (value: string): string => value.replace(/[\\%_]/gu, '\\$&');
  const words = [
    ...new Set(text.split(' ').filter((w) => w.length >= MIN_WORD_LENGTH)),
  ]
    .slice(0, MAX_SEARCH_WORDS)
    .map(escape);
  return words.length > 0 ? words : text === '' ? [] : [escape(text)];
}

const ATTRIBUTE_NAME = /^[A-Za-z][A-Za-z0-9_]{0,39}$/u;
const BATCH = 1_000;

function trimDecimal(value: Prisma.Decimal): string {
  const text = value.toFixed(6);
  return text.includes('.') ? text.replace(/\.?0+$/u, '') : text;
}

function dateOnly(value: Date | null): string | null {
  return value === null ? null : value.toISOString().slice(0, 10);
}

/** PostgreSQL storage of the uploaded price list; every query is tenant-scoped. */
export class PrismaSheetCatalogStore implements SheetCatalogReader {
  constructor(private readonly prisma: PrismaService) {}

  async meta(tenantId: string): Promise<SheetCatalogMeta | null> {
    const row = await this.prisma.sheetCatalog.findFirst({
      where: { tenantId },
      include: { tenant: { select: { timezone: true } } },
    });
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      sourceFilename: row.sourceFilename,
      uploadedAt: row.uploadedAt,
      freshnessDays: row.freshnessDays,
      rowCount: row.rowCount,
      acceptedCount: row.acceptedCount,
      rejectedCount: row.rejectedCount,
      mapping: row.mapping as ColumnMapping,
      options: row.options as MapOptions,
      timeZone: row.tenant.timezone,
    };
  }

  async searchItems(
    tenantId: string,
    query: SheetSearch,
  ): Promise<StoredItem[]> {
    const catalog = await this.prisma.sheetCatalog.findFirst({
      where: { tenantId },
      select: { id: true },
    });
    if (!catalog) return [];
    const conditions: Prisma.Sql[] = [
      Prisma.sql`tenant_id = ${tenantId}::uuid`,
      Prisma.sql`catalog_id = ${catalog.id}::uuid`,
    ];
    if (query.itemType)
      conditions.push(Prisma.sql`item_type = ${query.itemType}`);
    for (const [name, value] of Object.entries(query.attributes ?? {})) {
      // Names come from an untrusted tool call: fixed shape, and bound as a parameter.
      if (!ATTRIBUTE_NAME.test(name)) return [];
      conditions.push(
        Prisma.sql`lower(attributes ->> ${name}) = ${String(value).toLowerCase()}`,
      );
    }
    const words = searchWords(query.title);
    type Row = {
      key: string;
      title: string;
      item_type: string;
      attributes: Record<string, unknown>;
    };
    const where = Prisma.join(conditions, ' AND ');
    const rows =
      words.length === 0
        ? await this.prisma.$queryRaw<Row[]>(Prisma.sql`
            SELECT key, title, item_type, attributes
            FROM sheet_catalog_items
            WHERE ${where}
            ORDER BY title ASC, key ASC
            LIMIT ${query.limit} OFFSET ${query.offset}`)
        : // Each word of the phrase that is in the title scores one point; only
          // the best-scoring titles are returned, so a word that is in no title
          // ("tour", "price") never hides the match, and a second matching word
          // narrows the answer.
          await this.prisma.$queryRaw<Row[]>(Prisma.sql`
            WITH scored AS (
              SELECT key, title, item_type, attributes,
                ${Prisma.join(
                  words.map(
                    (word) =>
                      Prisma.sql`(CASE WHEN normalized_title LIKE ${`%${word}%`} THEN 1 ELSE 0 END)`,
                  ),
                  ' + ',
                )} AS score
              FROM sheet_catalog_items
              WHERE ${where}
            )
            SELECT key, title, item_type, attributes
            FROM scored
            WHERE score > 0 AND score = (SELECT max(score) FROM scored)
            ORDER BY title ASC, key ASC
            LIMIT ${query.limit} OFFSET ${query.offset}`);
    return rows.map((row) => ({
      key: row.key,
      title: row.title,
      itemType: row.item_type,
      attributes: row.attributes,
    }));
  }

  async getItem(tenantId: string, key: string): Promise<StoredItem | null> {
    const row = await this.prisma.sheetCatalogItem.findFirst({
      where: { tenantId, key },
    });
    return row
      ? {
          key: row.key,
          title: row.title,
          itemType: row.itemType,
          attributes: row.attributes as Record<string, unknown>,
        }
      : null;
  }

  async getOffers(tenantId: string, itemKey: string): Promise<StoredOffer[]> {
    const rows = await this.prisma.sheetCatalogOffer.findMany({
      where: { tenantId, itemKey },
      orderBy: [{ startsOn: 'asc' }, { key: 'asc' }],
    });
    return rows.map((row) => this.toOffer(row));
  }

  async getOffer(tenantId: string, key: string): Promise<StoredOffer | null> {
    const row = await this.prisma.sheetCatalogOffer.findFirst({
      where: { tenantId, key },
    });
    return row ? this.toOffer(row) : null;
  }

  private toOffer(row: {
    key: string;
    itemKey: string;
    price: Prisma.Decimal;
    currency: string;
    availability: string;
    seatsLeft: number | null;
    startsOn: Date | null;
    endsOn: Date | null;
    attributes: Prisma.JsonValue;
  }): StoredOffer {
    return {
      key: row.key,
      itemKey: row.itemKey,
      price: trimDecimal(row.price),
      currency: row.currency,
      availability: row.availability as StoredOffer['availability'],
      seatsLeft: row.seatsLeft,
      startsOn: dateOnly(row.startsOn),
      endsOn: dateOnly(row.endsOn),
      attributes: row.attributes as Record<string, unknown>,
    };
  }

  /**
   * Replaces the tenant's price list in ONE transaction (ADR 064 decision 6):
   * either the whole new file is live or the old one stays.
   */
  async replace(
    tenantId: string,
    input: SheetCatalogInput,
  ): Promise<SheetCatalogMeta> {
    const { result } = input;
    await this.prisma.$transaction(
      async (tx) => {
        const catalog = await tx.sheetCatalog.upsert({
          where: { tenantId },
          create: {
            tenantId,
            name: input.name,
            sourceFilename: input.sourceFilename,
            mapping: input.mapping as Prisma.InputJsonValue,
            options: input.options as Prisma.InputJsonValue,
            freshnessDays: input.freshnessDays,
            uploadedAt: input.uploadedAt,
            rowCount: result.rowCount,
            acceptedCount: result.offers.length,
            rejectedCount: result.errors.length,
          },
          update: {
            name: input.name,
            sourceFilename: input.sourceFilename,
            mapping: input.mapping as Prisma.InputJsonValue,
            options: input.options as Prisma.InputJsonValue,
            freshnessDays: input.freshnessDays,
            uploadedAt: input.uploadedAt,
            rowCount: result.rowCount,
            acceptedCount: result.offers.length,
            rejectedCount: result.errors.length,
          },
          select: { id: true },
        });
        await tx.sheetCatalogOffer.deleteMany({
          where: { tenantId, catalogId: catalog.id },
        });
        await tx.sheetCatalogItem.deleteMany({
          where: { tenantId, catalogId: catalog.id },
        });
        for (let i = 0; i < result.items.length; i += BATCH)
          await tx.sheetCatalogItem.createMany({
            data: result.items.slice(i, i + BATCH).map((item) => ({
              tenantId,
              catalogId: catalog.id,
              key: item.key,
              title: item.title,
              normalizedTitle: normalizeTitle(item.title),
              itemType: item.itemType,
              attributes: item.attributes as Prisma.InputJsonValue,
            })),
          });
        for (let i = 0; i < result.offers.length; i += BATCH)
          await tx.sheetCatalogOffer.createMany({
            data: result.offers.slice(i, i + BATCH).map((offer) => ({
              tenantId,
              catalogId: catalog.id,
              key: offer.key,
              itemKey: offer.itemKey,
              price: new Prisma.Decimal(offer.price.amount),
              currency: offer.price.currency,
              availability: offer.availability,
              seatsLeft: offer.seatsLeft ?? null,
              startsOn: offer.startsOn ? new Date(offer.startsOn) : null,
              endsOn: offer.endsOn ? new Date(offer.endsOn) : null,
              attributes: offer.attributes as Prisma.InputJsonValue,
              line: offer.line,
            })),
          });
      },
      { timeout: 60_000 },
    );
    const meta = await this.meta(tenantId);
    if (!meta) throw new Error('The price list vanished after saving');
    return meta;
  }
}
