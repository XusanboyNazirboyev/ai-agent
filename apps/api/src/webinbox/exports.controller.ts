import {
  Controller,
  ForbiddenException,
  Get,
  HttpException,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { PrismaService } from '../persistence/prisma.service.js';
import { SessionGuard, type InboxRequest } from './session.guard.js';
import {
  ExportInProgressError,
  ExportLock,
  ExportTooLargeError,
} from '../exports/export-lock.js';
import {
  ExportService,
  type LeadsExportFilters,
  type PeopleExportFilters,
} from '../exports/export.service.js';
import { invalidQuery } from '../tags/tag-errors.js';

interface StreamResponse {
  setHeader?(name: string, value: string): void;
  writeHead?(status: number, headers: Record<string, string>): void;
  write(chunk: string): boolean | void;
  end(): void;
}

const PeopleQuery = z.object({
  q: z.string().trim().max(80).optional(),
  tagId: z.string().uuid().optional(),
  fieldKey: z.string().max(64).optional(),
  fieldValue: z.string().max(600).optional(),
});

const LeadsQuery = z.object({
  stage: z.string().uuid().optional(),
  score: z.enum(['HOT', 'WARM', 'COLD']).optional(),
  tagId: z.string().uuid().optional(),
  fieldKey: z.string().max(64).optional(),
  fieldValue: z.string().max(600).optional(),
});

const allowed = new Set(['OWNER', 'ADMIN']);

@Controller('api/v1/exports')
@UseGuards(SessionGuard)
export class ExportsController {
  constructor(
    private readonly lock: ExportLock,
    private readonly exports: ExportService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('people.csv')
  async people(
    @Req() request: InboxRequest,
    @Query() query: unknown,
    @Res() res: StreamResponse,
  ): Promise<void> {
    const principal = request.principal!;
    if (!allowed.has(principal.role)) throw forbidden();
    const parsed = PeopleQuery.safeParse(query);
    if (!parsed.success) throw invalidQuery();
    const { fieldKey, fieldValue, ...rest } = parsed.data;
    if ((fieldKey === undefined) !== (fieldValue === undefined))
      throw invalidQuery();
    const filters: PeopleExportFilters = { ...rest, fieldKey, fieldValue };

    const release = await this.acquire(principal.tenantId);
    try {
      const total = await this.exports.countPeople(principal.tenantId, filters);
      if (total > this.exports.rowLimit) throw tooLarge();
      this.writeHeaders(res, this.filename('people'));
      const result = await this.exports.streamPeople(
        principal.tenantId,
        filters,
        res,
        { checked: true },
      );
      res.end();
      await this.audit(principal, 'export.people', 'people', result.rows, {
        ...(filters.q ? { q: true } : {}),
        ...(filters.tagId ? { tagId: filters.tagId } : {}),
        ...(filters.fieldKey ? { fieldKey: filters.fieldKey } : {}),
      });
    } catch (e) {
      if (e instanceof ExportTooLargeError) throw tooLarge();
      if (e instanceof ExportInProgressError) throw inProgress();
      throw e;
    } finally {
      await release();
    }
  }

  @Get('leads.csv')
  async leads(
    @Req() request: InboxRequest,
    @Query() query: unknown,
    @Res() res: StreamResponse,
  ): Promise<void> {
    const principal = request.principal!;
    if (!allowed.has(principal.role)) throw forbidden();
    const parsed = LeadsQuery.safeParse(query);
    if (!parsed.success) throw invalidQuery();
    const { fieldKey, fieldValue, ...rest } = parsed.data;
    if ((fieldKey === undefined) !== (fieldValue === undefined))
      throw invalidQuery();
    const filters: LeadsExportFilters = { ...rest, fieldKey, fieldValue };

    const release = await this.acquire(principal.tenantId);
    try {
      const total = await this.exports.countLeads(principal.tenantId, filters);
      if (total > this.exports.rowLimit) throw tooLarge();
      this.writeHeaders(res, this.filename('leads'));
      const result = await this.exports.streamLeads(
        principal.tenantId,
        filters,
        res,
        { checked: true },
      );
      res.end();
      await this.audit(principal, 'export.leads', 'leads', result.rows, {
        ...(filters.tagId ? { tagId: filters.tagId } : {}),
        ...(filters.fieldKey ? { fieldKey: filters.fieldKey } : {}),
        ...(filters.stage ? { stage: filters.stage } : {}),
        ...(filters.score ? { score: filters.score } : {}),
      });
    } catch (e) {
      if (e instanceof ExportTooLargeError) throw tooLarge();
      if (e instanceof ExportInProgressError) throw inProgress();
      throw e;
    } finally {
      await release();
    }
  }

  private async acquire(tenantId: string): Promise<() => Promise<void>> {
    try {
      return await this.lock.acquire(tenantId);
    } catch (e) {
      if (e instanceof ExportInProgressError) throw inProgress();
      throw e;
    }
  }

  private writeHeaders(res: StreamResponse, filename: string): void {
    const headers = {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    };
    if (res.writeHead) res.writeHead(200, headers);
    else if (res.setHeader) {
      for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
    }
  }

  private filename(kind: 'people' | 'leads'): string {
    const d = new Date();
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${kind}-${y}${m}${day}.csv`;
  }

  private async audit(
    principal: { tenantId: string; operatorId: string },
    action: string,
    entityId: string,
    rows: number,
    filters: Record<string, unknown>,
  ): Promise<void> {
    await this.prisma.auditEvent.create({
      data: {
        tenantId: principal.tenantId,
        actorType: 'OPERATOR',
        actorId: principal.operatorId,
        action,
        entityType: 'export',
        entityId,
        safeInputSummary: { rows, filters } as any,
      },
    });
  }
}

function forbidden(): ForbiddenException {
  return new ForbiddenException({
    code: 'FORBIDDEN',
    message: 'Not allowed',
    i18nKey: 'errors.forbidden',
  });
}
function tooLarge(): HttpException {
  return new HttpException(
    {
      code: 'EXPORT_TOO_LARGE',
      message: 'Export too large',
      i18nKey: 'errors.EXPORT_TOO_LARGE',
    },
    413,
  );
}
function inProgress(): HttpException {
  return new HttpException(
    {
      code: 'EXPORT_IN_PROGRESS',
      message: 'Export in progress',
      i18nKey: 'errors.EXPORT_IN_PROGRESS',
    },
    429,
  );
}
