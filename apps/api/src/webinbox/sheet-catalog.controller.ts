import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { SheetReadError } from '../connectors/spreadsheet/csv-reader.js';
import { SheetFetchError } from '../connectors/spreadsheet/google-sheet-fetch.js';
import {
  SheetCatalogError,
  SheetCatalogService,
  SheetConfigSchema,
  type SheetConfig,
  type SheetPreview,
  type SheetStatus,
} from '../connectors/spreadsheet/sheet-catalog.service.js';
import { SessionGuard, type InboxRequest } from './session.guard.js';

const LinkBody = z.object({ url: z.string().trim().min(1).max(500) }).strict();
const MAX_CONFIG_LENGTH = 4_000;
const MAX_FILENAME_LENGTH = 200;

function bad(code: string, message: string): BadRequestException {
  return new BadRequestException({ code, message, i18nKey: `errors.${code}` });
}

/** The `config` query value: JSON, strict, bounded. */
function parseConfig(raw: string | undefined): SheetConfig {
  if (raw === undefined || raw === '') return {};
  if (raw.length > MAX_CONFIG_LENGTH)
    throw bad('INVALID_QUERY', 'config is too long');
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw bad('INVALID_QUERY', 'config is not valid JSON');
  }
  const parsed = SheetConfigSchema.safeParse(json);
  if (!parsed.success)
    throw bad('INVALID_QUERY', 'config has an unknown or invalid field');
  return parsed.data;
}

function csvOf(body: unknown): string {
  if (typeof body !== 'string' || body.trim() === '')
    throw bad('INVALID_BODY', 'Send the file as text/csv');
  return body;
}

/** Runs `work`, turning the reader's and the service's refusals into 400s. */
function translate<T>(work: () => T): T {
  try {
    return work();
  } catch (error) {
    if (
      error instanceof SheetReadError ||
      error instanceof SheetCatalogError ||
      error instanceof SheetFetchError
    )
      throw bad(error.code, error.message);
    throw error;
  }
}

async function translateAsync<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (
      error instanceof SheetReadError ||
      error instanceof SheetCatalogError ||
      error instanceof SheetFetchError
    )
      throw bad(error.code, error.message);
    throw error;
  }
}

/**
 * The tenant's price list as a catalog (ADR 064). OWNER and ADMIN only; the
 * file arrives as `text/csv`, the mapping and options in the `config` query.
 */
@Controller('api/v1/catalog/sheet')
@UseGuards(SessionGuard)
export class SheetCatalogController {
  constructor(private readonly sheets: SheetCatalogService) {}

  private manager(request: InboxRequest): {
    tenantId: string;
    operatorId: string;
  } {
    const { tenantId, operatorId, role } = request.principal!;
    if (role !== 'OWNER' && role !== 'ADMIN')
      throw new ForbiddenException({
        code: 'FORBIDDEN',
        message: 'Not allowed',
        i18nKey: 'errors.forbidden',
      });
    return { tenantId, operatorId };
  }

  @Get()
  async status(@Req() request: InboxRequest): Promise<SheetStatus> {
    return this.sheets.status(this.manager(request).tenantId);
  }

  /** Reads and maps the file; nothing is saved. */
  @Post('preview')
  preview(
    @Req() request: InboxRequest,
    @Body() body: unknown,
    @Query('config') config?: string,
  ): SheetPreview {
    this.manager(request);
    return translate(() =>
      this.sheets.preview(csvOf(body), parseConfig(config)),
    );
  }

  /** Saves the file as the tenant's catalog, replacing the previous one. */
  @Post()
  async upload(
    @Req() request: InboxRequest,
    @Body() body: unknown,
    @Query('config') config?: string,
    @Query('filename') filename?: string,
  ): Promise<{
    uploadedAt: string;
    accepted: number;
    rejected: number;
    catalogBound: boolean;
    boundTo: string | null;
  }> {
    const actor = this.manager(request);
    const csv = csvOf(body);
    const settings = parseConfig(config);
    const name = filename?.slice(0, MAX_FILENAME_LENGTH) ?? null;
    const done = await translateAsync(() =>
      this.sheets.commit(actor, csv, settings, name),
    );
    return {
      uploadedAt: done.meta.uploadedAt.toISOString(),
      accepted: done.meta.acceptedCount,
      rejected: done.rejected,
      catalogBound: done.catalogBound,
      boundTo: done.boundTo,
    };
  }

  /** Reads a shared Google Sheets link on the server; nothing is saved. */
  @Post('from-link')
  async fromLink(
    @Req() request: InboxRequest,
    @Body() body: unknown,
  ): Promise<{ csv: string; sourceUrl: string }> {
    this.manager(request);
    const parsed = LinkBody.safeParse(body);
    if (!parsed.success) throw bad('INVALID_BODY', 'Send {"url": "..."}');
    return translateAsync(() => this.sheets.fetchFromLink(parsed.data.url));
  }

  /** Reloads the saved link now, with the saved columns. */
  @Post('refresh')
  async refresh(
    @Req() request: InboxRequest,
  ): Promise<{ accepted: number; rejected: number }> {
    const actor = this.manager(request);
    return translateAsync(() =>
      this.sheets.refresh(actor.tenantId, { operatorId: actor.operatorId }),
    );
  }
}
