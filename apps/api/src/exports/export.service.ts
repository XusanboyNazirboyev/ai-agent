import { Injectable } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../persistence/prisma.service.js';
import {
  PeopleService,
  type PersonExportRow,
} from '../persons/people.service.js';
import { parseFieldFilter, type FieldFilter } from '../tags/field-filter.js';
import { invalidQuery } from '../tags/tag-errors.js';
import { activeFieldDefs, tagsOfLeads } from '../tags/tag-reads.js';
import {
  CSV_PAGE_SIZE,
  EXPORT_ROW_LIMIT,
  csvChunk,
  customFieldColumns,
  type CsvColumn,
} from './csv.js';
import { ExportAbortedError, ExportTooLargeError } from './export-lock.js';

export interface PeopleExportFilters {
  q?: string;
  tagId?: string;
  fieldKey?: string;
  fieldValue?: string;
}
export interface LeadsExportFilters {
  stage?: string;
  score?: 'HOT' | 'WARM' | 'COLD';
  tagId?: string;
  fieldKey?: string;
  fieldValue?: string;
}

/** Where the CSV goes. `write` resolves when the chunk was flushed. */
export interface CsvSink {
  readonly closed: boolean;
  write(chunk: string): Promise<void>;
}

interface LeadExportRow {
  id: string;
  personId: string | null;
  contactName: string | null;
  stage: string | null;
  score: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
  tags: string[];
  customFields: Record<string, unknown>;
}

function asRecord(value: Prisma.JsonValue): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

@Injectable()
export class ExportService {
  /** Public so tests can lower them (ADR 056). */
  rowLimit = EXPORT_ROW_LIMIT;
  pageSize = CSV_PAGE_SIZE;

  constructor(
    private readonly prisma: PrismaService,
    private readonly people: PeopleService,
  ) {}

  async countPeople(
    tenantId: string,
    filters: PeopleExportFilters,
  ): Promise<number> {
    const field = await this.resolveField(tenantId, 'PERSON', filters);
    return this.people.count(tenantId, {
      q: filters.q?.trim() || undefined,
      tagId: filters.tagId,
      field,
    });
  }

  async countLeads(
    tenantId: string,
    filters: LeadsExportFilters,
  ): Promise<number> {
    const field = await this.resolveField(tenantId, 'LEAD', filters);
    return this.prisma.lead.count({
      where: this.leadWhere(tenantId, filters, field),
    });
  }

  /**
   * Streams the people CSV. Throws ExportTooLargeError BEFORE the first write
   * when the filtered set is over the limit, so the caller can still answer
   * with a normal error response.
   */
  async streamPeople(
    tenantId: string,
    filters: PeopleExportFilters,
    sink: CsvSink,
  ): Promise<{ rows: number }> {
    const total = await this.countPeople(tenantId, filters);
    if (total > this.rowLimit) throw new ExportTooLargeError();
    const field = await this.resolveField(tenantId, 'PERSON', filters);
    const defs = await activeFieldDefs(this.prisma, tenantId, 'PERSON');
    const cols: CsvColumn<PersonExportRow>[] = [
      { header: 'person_id', kind: 'id', get: (r) => r.id },
      { header: 'name', kind: 'text', get: (r) => r.displayName },
      { header: 'phone', kind: 'phone', get: (r) => r.phone },
      { header: 'channels', kind: 'text', get: (r) => r.channels.join('; ') },
      { header: 'contacts', kind: 'number', get: (r) => r.contactsCount },
      {
        header: 'conversations',
        kind: 'number',
        get: (r) => r.conversationCount,
      },
      { header: 'leads', kind: 'number', get: (r) => r.leadCount },
      {
        header: 'last_activity_at',
        kind: 'date',
        get: (r) => r.lastActivityAt,
      },
      {
        header: 'marketing_opt_out',
        kind: 'boolean',
        get: (r) => r.marketingOptOut,
      },
      { header: 'created_at', kind: 'date', get: (r) => r.createdAt },
      { header: 'tags', kind: 'text', get: (r) => r.tags.join('; ') },
      ...customFieldColumns<PersonExportRow>(defs),
    ];
    let cursor: string | undefined;
    let first = true;
    let rows = 0;
    do {
      if (sink.closed) throw new ExportAbortedError();
      const page = await this.people.listForExport(tenantId, {
        q: filters.q?.trim() || undefined,
        tagId: filters.tagId,
        field,
        cursor,
        limit: this.pageSize,
      });
      rows += page.items.length;
      if (rows > this.rowLimit) throw new ExportTooLargeError();
      if (page.items.length > 0 || first) {
        await sink.write(csvChunk(cols, page.items, first));
        first = false;
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return { rows };
  }

  async streamLeads(
    tenantId: string,
    filters: LeadsExportFilters,
    sink: CsvSink,
  ): Promise<{ rows: number }> {
    const total = await this.countLeads(tenantId, filters);
    if (total > this.rowLimit) throw new ExportTooLargeError();
    const field = await this.resolveField(tenantId, 'LEAD', filters);
    const defs = await activeFieldDefs(this.prisma, tenantId, 'LEAD');
    const cols: CsvColumn<LeadExportRow>[] = [
      { header: 'lead_id', kind: 'id', get: (r) => r.id },
      { header: 'person_id', kind: 'id', get: (r) => r.personId },
      { header: 'contact_name', kind: 'text', get: (r) => r.contactName },
      { header: 'stage', kind: 'text', get: (r) => r.stage },
      { header: 'score', kind: 'text', get: (r) => r.score },
      { header: 'status', kind: 'text', get: (r) => r.status },
      { header: 'created_at', kind: 'date', get: (r) => r.createdAt },
      { header: 'updated_at', kind: 'date', get: (r) => r.updatedAt },
      { header: 'tags', kind: 'text', get: (r) => r.tags.join('; ') },
      ...customFieldColumns<LeadExportRow>(defs),
    ];
    const where = this.leadWhere(tenantId, filters, field);
    let cursor: string | undefined;
    let first = true;
    let rows = 0;
    do {
      if (sink.closed) throw new ExportAbortedError();
      const batch = await this.prisma.lead.findMany({
        where: { ...where, ...(cursor ? { id: { lt: cursor } } : {}) },
        orderBy: { id: 'desc' },
        take: this.pageSize,
        select: {
          id: true,
          score: true,
          status: true,
          createdAt: true,
          updatedAt: true,
          customFields: true,
          pipelineStage: { select: { name: true, code: true } },
          contact: { select: { name: true, personId: true } },
        },
      });
      const tagMap = await tagsOfLeads(
        this.prisma,
        tenantId,
        batch.map((l) => l.id),
      );
      const mapped = batch.map((l): LeadExportRow => ({
        id: l.id,
        personId: l.contact.personId,
        contactName: l.contact.name,
        stage: l.pipelineStage?.name ?? l.pipelineStage?.code ?? null,
        score: l.score,
        status: l.status,
        createdAt: l.createdAt,
        updatedAt: l.updatedAt,
        tags: (tagMap.get(l.id) ?? []).map((t) => t.name),
        customFields: asRecord(l.customFields),
      }));
      rows += mapped.length;
      if (rows > this.rowLimit) throw new ExportTooLargeError();
      if (mapped.length > 0 || first) {
        await sink.write(csvChunk(cols, mapped, first));
        first = false;
      }
      cursor =
        batch.length === this.pageSize
          ? batch[batch.length - 1]!.id
          : undefined;
    } while (cursor);
    return { rows };
  }

  /** Live contact, and a person that is neither merged away nor deleted. */
  private leadWhere(
    tenantId: string,
    filters: LeadsExportFilters,
    field?: FieldFilter,
  ): Prisma.LeadWhereInput {
    return {
      tenantId,
      // ADR 062: archived leads are not exported.
      archivedAt: null,
      contact: {
        deletedAt: null,
        OR: [
          { personId: null },
          { person: { deletedAt: null, mergedIntoId: null } },
        ],
      },
      ...(filters.stage ? { pipelineStageId: filters.stage } : {}),
      ...(filters.score ? { score: filters.score } : {}),
      ...(filters.tagId
        ? { tags: { some: { tenantId, tagId: filters.tagId } } }
        : {}),
      ...(field
        ? { customFields: { path: [field.key], equals: field.value } }
        : {}),
    };
  }

  private async resolveField(
    tenantId: string,
    entity: 'PERSON' | 'LEAD',
    filters: { fieldKey?: string; fieldValue?: string },
  ): Promise<FieldFilter | undefined> {
    const { fieldKey, fieldValue } = filters;
    if ((fieldKey === undefined) !== (fieldValue === undefined))
      throw invalidQuery();
    if (fieldKey === undefined || fieldValue === undefined) return undefined;
    return parseFieldFilter(
      this.prisma,
      tenantId,
      entity,
      fieldKey,
      fieldValue,
    );
  }
}
