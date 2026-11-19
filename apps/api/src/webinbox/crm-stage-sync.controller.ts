import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpException,
  Param,
  ParseUUIDPipe,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import {
  CrmStageSyncService,
  StageSyncRefusal,
  type StageSyncView,
} from '../connectors/bitrix24/crm-stage-sync.service.js';
import { SessionGuard, type InboxRequest } from './session.guard.js';

const SaveBody = z
  .object({
    enabled: z.boolean(),
    mappings: z
      .array(
        z
          .object({
            externalStageId: z.string().min(1).max(100),
            leadStageId: z.string().uuid().nullable(),
          })
          .strict(),
      )
      .max(200),
  })
  .strict();

const REFUSAL: Record<
  StageSyncRefusal['code'],
  { status: number; i18nKey: string }
> = {
  NOT_FOUND: { status: 404, i18nKey: 'errors.notFound' },
  INVALID_BODY: { status: 400, i18nKey: 'errors.invalidBody' },
  CRM_UNREACHABLE: { status: 502, i18nKey: 'errors.crmUnreachable' },
  CRM_REJECTED: { status: 502, i18nKey: 'errors.crmRejected' },
};

/** amoCRM has its own wording; the generic keys name Bitrix24. */
const AMOCRM_KEYS: Partial<Record<StageSyncRefusal['code'], string>> = {
  CRM_UNREACHABLE: 'amocrm.err.unreachable',
  CRM_REJECTED: 'amocrm.err.rejected',
};

function refusal(error: StageSyncRefusal): HttpException {
  const spec = REFUSAL[error.code];
  const i18nKey =
    (error.provider === 'amocrm' ? AMOCRM_KEYS[error.code] : undefined) ??
    spec.i18nKey;
  return new HttpException(
    { code: error.code, message: error.code, i18nKey },
    spec.status,
  );
}

/**
 * Stage sync settings of a connected Bitrix24 (ADR 079). OWNER/ADMIN only;
 * the session guard enforces the session and CSRF on changes. Audit rows
 * carry counts, never portal URLs or tokens.
 */
@Controller('api/v1/connectors')
@UseGuards(SessionGuard)
export class CrmStageSyncController {
  constructor(private readonly sync: CrmStageSyncService) {}

  private manager(request: InboxRequest): {
    tenantId: string;
    operatorId: string;
  } {
    const principal = request.principal!;
    if (principal.role !== 'OWNER' && principal.role !== 'ADMIN')
      throw new ForbiddenException({
        code: 'FORBIDDEN',
        message: 'Not allowed',
        i18nKey: 'errors.forbidden',
      });
    return { tenantId: principal.tenantId, operatorId: principal.operatorId };
  }

  @Get(':id/stage-sync')
  async get(
    @Req() request: InboxRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<StageSyncView> {
    const who = this.manager(request);
    try {
      return await this.sync.view(who.tenantId, id);
    } catch (error) {
      if (error instanceof StageSyncRefusal) throw refusal(error);
      throw error;
    }
  }

  @Put(':id/stage-sync')
  async put(
    @Req() request: InboxRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: unknown,
  ): Promise<StageSyncView> {
    const who = this.manager(request);
    const parsed = SaveBody.safeParse(body);
    if (!parsed.success) throw refusal(new StageSyncRefusal('INVALID_BODY'));
    try {
      return await this.sync.save(
        who.tenantId,
        id,
        who.operatorId,
        parsed.data,
      );
    } catch (error) {
      if (error instanceof StageSyncRefusal) throw refusal(error);
      throw error;
    }
  }
}
