import type { ServerResponse } from 'node:http';
import {
  Controller,
  Get,
  HttpException,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../persistence/prisma.service.js';
import { exportFilename } from '../exports/csv.js';
import {
  ExportAbortedError,
  ExportInProgressError,
  ExportLock,
  ExportTooLargeError,
} from '../exports/export-lock.js';
import { ExportService, type CsvSink } from '../exports/export.service.js';
import { forbidden, invalidQuery } from '../tags/tag-errors.js';
import { SessionGuard, type InboxRequest } from './session.guard.js';
import type { InboxPrincipal } from './session.service.js';

const FieldPair = {
  fieldKey: z.string().max(64).optional(),
  fieldValue: z.string().max(600).optional(),
};

const PeopleQuery = z.object({
  q: z.string().trim().max(80).optional(),
  tagId: z.string().uuid().optional(),
  ...FieldPair,
});

const LeadsQuery = z.object({
  stage: z.string().uuid().optional(),
  score: z.enum(['HOT', 'WARM', 'COLD']).optional(),
  tagId: z.string().uuid().optional(),
  ...FieldPair,
});

/** A bulk copy of personal data: owners and admins only (ADR 056). */
const ALLOWED_ROLES = new Set(['OWNER', 'ADMIN']);

/**
 * CSV exports of people and leads (ADR 056). Errors found before the first
 * byte are normal JSON errors. An error AFTER the headers went out cannot
 * change the status line, so the connection is destroyed: the client gets a
 * failed download instead of a file that looks complete but is cut short.
 */
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
    @Res() res: ServerResponse,
  ): Promise<void> {
    const principal = this.authorise(request);
    const parsed = PeopleQuery.safeParse(query);
    if (!parsed.success) throw invalidQuery();
    const filters = parsed.data;
    if ((filters.fieldKey === undefined) !== (filters.fieldValue === undefined))
      throw invalidQuery();
    await this.run(principal, res, 'people', 'export.people', {
      stream: (sink) =>
        this.exports.streamPeople(principal.tenantId, filters, sink),
      summary: {
        ...(filters.q ? { q: true } : {}),
        ...(filters.tagId ? { tagId: filters.tagId } : {}),
        ...(filters.fieldKey ? { fieldKey: filters.fieldKey } : {}),
      },
    });
  }

  @Get('leads.csv')
  async leads(
    @Req() request: InboxRequest,
    @Query() query: unknown,
    @Res() res: ServerResponse,
  ): Promise<void> {
    const principal = this.authorise(request);
    const parsed = LeadsQuery.safeParse(query);
    if (!parsed.success) throw invalidQuery();
    const filters = parsed.data;
    if ((filters.fieldKey === undefined) !== (filters.fieldValue === undefined))
      throw invalidQuery();
    await this.run(principal, res, 'leads', 'export.leads', {
      stream: (sink) =>
        this.exports.streamLeads(principal.tenantId, filters, sink),
      summary: {
        ...(filters.stage ? { stage: filters.stage } : {}),
        ...(filters.score ? { score: filters.score } : {}),
        ...(filters.tagId ? { tagId: filters.tagId } : {}),
        ...(filters.fieldKey ? { fieldKey: filters.fieldKey } : {}),
      },
    });
  }

  private authorise(request: InboxRequest): InboxPrincipal {
    const principal = request.principal!;
    if (!ALLOWED_ROLES.has(principal.role)) throw forbidden();
    return principal;
  }

  private async run(
    principal: InboxPrincipal,
    res: ServerResponse,
    kind: 'people' | 'leads',
    action: 'export.people' | 'export.leads',
    job: {
      stream: (sink: CsvSink) => Promise<{ rows: number }>;
      summary: Prisma.InputJsonObject;
    },
  ): Promise<void> {
    const release = await this.acquire(principal.tenantId);
    try {
      const sink = csvSink(res, exportFilename(kind));
      const { rows } = await job.stream(sink);
      // Audited before the last byte: a failed audit fails the download.
      await this.prisma.auditEvent.create({
        data: {
          tenantId: principal.tenantId,
          actorType: 'OPERATOR',
          actorId: principal.operatorId,
          action,
          entityType: 'export',
          entityId: kind,
          safeInputSummary: { rows, filters: job.summary },
        },
      });
      res.end();
    } catch (e) {
      if (e instanceof ExportAbortedError) {
        res.destroy();
        return;
      }
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (e instanceof ExportTooLargeError) throw tooLarge();
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
}

/** Sends the headers with the first chunk, honours back-pressure and abort. */
function csvSink(res: ServerResponse, filename: string): CsvSink {
  let closed = false;
  res.once('close', () => {
    closed = true;
  });
  return {
    get closed(): boolean {
      return closed;
    },
    async write(chunk: string): Promise<void> {
      if (closed) throw new ExportAbortedError();
      if (!res.headersSent)
        res.writeHead(200, {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="${filename}"`,
          'Cache-Control': 'no-store',
        });
      if (!res.write(chunk))
        await new Promise<void>((resolve) => {
          const done = (): void => {
            res.off('drain', done);
            res.off('close', done);
            resolve();
          };
          res.once('drain', done);
          res.once('close', done);
        });
      if (closed) throw new ExportAbortedError();
    },
  };
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
