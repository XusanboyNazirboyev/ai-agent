import { Injectable } from '@nestjs/common';
import { PrismaService } from '../persistence/prisma.service.js';
import { PeopleService } from '../persons/people.service.js';
import { parseFieldFilter, type FieldFilter } from '../tags/field-filter.js';
import { activeFieldDefs, tagsOfLeads } from '../tags/tag-reads.js';
import { invalidQuery } from '../tags/tag-errors.js';
import {
  CSV_PAGE_SIZE,
  EXPORT_ROW_LIMIT,
  csvChunk,
  type CsvColumn,
} from './csv.js';
import { ExportTooLargeError } from './export-lock.js';

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

type StreamOut = { write: (chunk: string) => boolean | void };

@Injectable()
export class ExportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly people: PeopleService,
  ) {}

  get rowLimit(): number {
    return EXPORT_ROW_LIMIT;
  }

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
      where: await this.leadWhere(tenantId, filters, field),
    });
  }

  async streamPeople(
    tenantId: string,
    filters: PeopleExportFilters,
    out: StreamOut,
    opts?: { checked?: boolean },
  ): Promise<{ rows: number }> {
    if (!opts?.checked) {
      const total = await this.countPeople(tenantId, filters);
      if (total > EXPORT_ROW_LIMIT) throw new ExportTooLargeError();
    }
    const defs = await activeFieldDefs(this.prisma, tenantId, 'PERSON');
    const field = await this.resolveField(tenantId, 'PERSON', filters);
    const baseCols: CsvColumn<any>[] = [
      { header: 'person_id', kind: 'id', get: (r) => r.id },
      { header: 'name', kind: 'text', get: (r) => r.displayName },
      { header: 'phone', kind: 'text', get: (r) => r.phone },
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
    ];
    const dynCols: CsvColumn<any>[] = defs.map((d) => ({
      header: d.label,
      kind: 'text' as const,
      get: (r: any) => {
        const v = r.customFields?.[d.key];
        if (v === null || v === undefined) return null;
        if (d.type === 'BOOLEAN') return v ? 'true' : 'false';
        return String(v);
      },
    }));
    const cols = [...baseCols, ...dynCols];
    let cursor: string | undefined;
    let first = true;
    let rows = 0;
    for (;;) {
      const page = await this.people.listForExport(tenantId, {
        q: filters.q?.trim() || undefined,
        tagId: filters.tagId,
        field,
        cursor,
        limit: CSV_PAGE_SIZE,
      });
      if (page.items.length === 0) break;
      out.write(csvChunk(cols, page.items, first));
      first = false;
      rows += page.items.length;
      cursor = page.nextCursor ?? undefined;
      if (!cursor) break;
    }
    if (first) out.write(csvChunk(cols, [], true));
    return { rows };
  }

  async streamLeads(
    tenantId: string,
    filters: LeadsExportFilters,
    out: StreamOut,
    opts?: { checked?: boolean },
  ): Promise<{ rows: number }> {
    if (!opts?.checked) {
      const total = await this.countLeads(tenantId, filters);
      if (total > EXPORT_ROW_LIMIT) throw new ExportTooLargeError();
    }
    const defs = await activeFieldDefs(this.prisma, tenantId, 'LEAD');
    const baseCols: CsvColumn<any>[] = [
      { header: 'lead_id', kind: 'id', get: (r) => r.id },
      { header: 'person_id', kind: 'id', get: (r) => r.personId },
      { header: 'contact_name', kind: 'text', get: (r) => r.contactName },
      { header: 'stage', kind: 'text', get: (r) => r.stage },
      { header: 'score', kind: 'text', get: (r) => r.score },
      { header: 'status', kind: 'text', get: (r) => r.status },
      { header: 'created_at', kind: 'date', get: (r) => r.createdAt },
      { header: 'updated_at', kind: 'date', get: (r) => r.updatedAt },
      { header: 'tags', kind: 'text', get: (r) => r.tags.join('; ') },
    ];
    const dynCols: CsvColumn<any>[] = defs.map((d) => ({
      header: d.label,
      kind: 'text' as const,
      get: (r: any) => {
        const v = r.customFields?.[d.key];
        if (v === null || v === undefined) return null;
        if (d.type === 'BOOLEAN') return v ? 'true' : 'false';
        return String(v);
      },
    }));
    const cols = [...baseCols, ...dynCols];
    const field = await this.resolveField(tenantId, 'LEAD', filters);
    const where = await this.leadWhere(tenantId, filters, field);
    let cursor: string | undefined;
    let first = true;
    let rows = 0;
    for (;;) {
      const batch = await this.prisma.lead.findMany({
        where: {
          ...where,
          ...(cursor ? { id: { lt: cursor } } : {}),
        },
        orderBy: [{ id: 'desc' }],
        take: CSV_PAGE_SIZE,
        select: {
          id: true,
          score: true,
          status: true,
          createdAt: true,
          updatedAt: true,
          customFields: true,
          pipelineStage: { select: { name: true, code: true } },
          contact: {
            select: { name: true, personId: true, deletedAt: true },
          },
        },
      });
      if (batch.length === 0) break;
      const tagMap = await tagsOfLeads(
        this.prisma,
        tenantId,
        batch.map((l) => l.id),
      );
      const mapped = batch
        .filter((l) => l.contact.deletedAt === null)
        .map((l) => ({
          id: l.id,
          personId: l.contact.personId,
          contactName: l.contact.name,
          stage: l.pipelineStage?.name ?? l.pipelineStage?.code ?? null,
          score: l.score,
          status: l.status,
          createdAt: l.createdAt.toISOString(),
          updatedAt: l.updatedAt.toISOString(),
          tags: (tagMap.get(l.id) ?? []).map((t) => t.name),
          customFields:
            l.customFields &&
            typeof l.customFields === 'object' &&
            !Array.isArray(l.customFields)
              ? (l.customFields as Record<string, unknown>)
              : {},
        }));
      if (mapped.length > 0) {
        out.write(csvChunk(cols, mapped, first));
        first = false;
        rows += mapped.length;
      }
      cursor = batch[batch.length - 1]?.id;
      if (!cursor || batch.length < CSV_PAGE_SIZE) break;
    }
    if (first) out.write(csvChunk(cols, [], true));
    return { rows };
  }

  private async leadWhere(
    tenantId: string,
    filters: LeadsExportFilters,
    field?: FieldFilter,
  ): Promise<any> {
    return {
      tenantId,
      contact: {
        deletedAt: null,
        person: { deletedAt: null, mergedIntoId: null },
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
    if (fieldKey !== undefined && fieldValue !== undefined) {
      return parseFieldFilter(
        this.prisma,
        tenantId,
        entity,
        fieldKey,
        fieldValue,
      );
    }
    return undefined;
  }
}
