import {
  Body,
  Controller,
  HttpException,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { PrismaService } from '../persistence/prisma.service.js';
import { PHONE_KEY_SQL, phoneKey } from '../persons/person-merge.js';
import {
  forbidden,
  invalidBody,
  invalidValue,
  notFound,
  stageNotOpen,
} from '../pipelines/pipeline-errors.js';
import { SessionGuard, type InboxRequest } from '../webinbox/session.guard.js';
import { chooseStage, parseManualLeadBody } from './manual-lead-rules.js';
import { ManualLeadService } from './manual-lead.service.js';

/** Rows accepted per request; the client sends longer files in chunks. */
export const MAX_IMPORT_ROWS = 200;
/** Source given to a row that names none. */
export const IMPORT_DEFAULT_SOURCE = 'import';

const ImportBody = z
  .object({
    pipelineId: z.string().uuid(),
    stageId: z.string().uuid().optional(),
    rows: z.array(z.unknown()).min(1).max(MAX_IMPORT_ROWS),
  })
  .strict();

export interface LeadImportResult {
  created: number;
  skipped: Array<{ row: number; code: string }>;
}

/**
 * CSV import of leads (ADR 077): the client parses the file, this validates
 * every row with the manual-lead rules and creates each through
 * `ManualLeadService` (own transaction per row). OWNER/ADMIN only.
 */
@Controller('api/v1/leads/import')
@UseGuards(SessionGuard)
export class LeadImportController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly manualLeads: ManualLeadService,
  ) {}

  @Post()
  async import(
    @Req() request: InboxRequest,
    @Body() body: unknown,
  ): Promise<LeadImportResult> {
    const { tenantId, operatorId, role } = request.principal!;
    if (role !== 'OWNER' && role !== 'ADMIN') throw forbidden();
    const parsed = ImportBody.safeParse(body);
    if (!parsed.success) throw invalidBody();
    const { pipelineId, rows } = parsed.data;
    const stageId = await this.resolveStage(
      tenantId,
      pipelineId,
      parsed.data.stageId,
    );

    const skipped: LeadImportResult['skipped'] = [];
    const valid: Array<{
      index: number;
      input: NonNullable<ReturnType<typeof parseOk>>;
    }> = [];
    rows.forEach((raw, index) => {
      const input = parseOk(raw, pipelineId, stageId);
      if (input) valid.push({ index, input });
      else skipped.push({ row: index, code: 'INVALID_VALUE' });
    });

    const taken = await this.takenKeys(
      tenantId,
      pipelineId,
      valid.flatMap((v) => phoneKey(v.input.phone) ?? []),
    );
    const seen = new Set<string>();
    let created = 0;
    for (const { index, input } of valid) {
      const key = phoneKey(input.phone);
      if (key !== null) {
        if (taken.has(key) || seen.has(key)) {
          skipped.push({ row: index, code: 'DUPLICATE' });
          continue;
        }
        seen.add(key);
      }
      try {
        await this.manualLeads.create({ tenantId, operatorId }, input);
        created += 1;
      } catch (error: unknown) {
        // A row the rules refuse now (the stage archived meanwhile, an
        // owner deactivated) is reported; the rows before it stay created.
        if (!(error instanceof HttpException)) throw error;
        skipped.push({ row: index, code: errorCode(error) });
      }
    }
    skipped.sort((a, b) => a.row - b.row);

    await this.prisma.auditEvent.create({
      data: {
        tenantId,
        actorType: 'OPERATOR',
        actorId: operatorId,
        action: 'lead.imported',
        entityType: 'pipeline',
        entityId: pipelineId,
        // Counts only: never a name, phone or note.
        safeInputSummary: {
          stageId,
          rows: rows.length,
          created,
          skipped: skipped.length,
        },
      },
    });
    return { created, skipped };
  }

  private async resolveStage(
    tenantId: string,
    pipelineId: string,
    requested: string | undefined,
  ): Promise<string> {
    const pipeline = await this.prisma.pipeline.findFirst({
      where: { tenantId, id: pipelineId, archivedAt: null },
      select: { id: true },
    });
    if (!pipeline) throw notFound();
    if (requested) {
      const stage = await this.prisma.leadStage.findFirst({
        where: { tenantId, id: requested, archivedAt: null },
        select: { id: true, pipelineId: true, kind: true },
      });
      const choice = chooseStage(stage, pipelineId);
      if (choice.ok) return choice.stageId;
      if (choice.code === 'NOT_FOUND') throw notFound();
      if (choice.code === 'STAGE_NOT_OPEN') throw stageNotOpen();
      throw invalidValue();
    }
    const first = await this.prisma.leadStage.findFirst({
      where: { tenantId, pipelineId, archivedAt: null, kind: 'OPEN' },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true },
    });
    if (!first) throw stageNotOpen();
    return first.id;
  }

  /** Phone keys already on a contact with an active lead of the pipeline. */
  private async takenKeys(
    tenantId: string,
    pipelineId: string,
    keys: string[],
  ): Promise<Set<string>> {
    if (keys.length === 0) return new Set();
    const rows = await this.prisma.$transaction((tx) =>
      tx.$queryRawUnsafe<Array<{ key: string }>>(
        `SELECT DISTINCT ${PHONE_KEY_SQL('c.phone')} AS key
         FROM leads l
         JOIN contacts c ON c.tenant_id = l.tenant_id AND c.id = l.contact_id
         WHERE l.tenant_id = $1::uuid AND l.pipeline_id = $2::uuid
           AND l.archived_at IS NULL AND c.deleted_at IS NULL
           AND c.phone IS NOT NULL
           AND ${PHONE_KEY_SQL('c.phone')} = ANY($3::text[])`,
        tenantId,
        pipelineId,
        [...new Set(keys)],
      ),
    );
    return new Set(rows.map((r) => r.key));
  }
}

function errorCode(error: HttpException): string {
  const response = error.getResponse();
  return typeof response === 'object' &&
    response !== null &&
    'code' in response &&
    typeof response.code === 'string'
    ? response.code
    : 'INVALID_VALUE';
}

function parseOk(
  raw: unknown,
  pipelineId: string,
  stageId: string,
):
  | Extract<ReturnType<typeof parseManualLeadBody>, { ok: true }>['input']
  | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
    return null;
  const row = { ...(raw as Record<string, unknown>) };
  if (typeof row.source !== 'string' || row.source.trim() === '')
    row.source = IMPORT_DEFAULT_SOURCE;
  const parsed = parseManualLeadBody({ ...row, pipelineId, stageId });
  return parsed.ok ? parsed.input : null;
}
