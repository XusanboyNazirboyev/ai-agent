import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { SessionGuard, type InboxRequest } from '../webinbox/session.guard.js';
import { ActionService } from './action.service.js';

const ResolveBody = z.object({
  outcome: z.enum(['SUCCEEDED', 'FAILED']),
  externalId: z.string().trim().min(1).max(200).optional(),
});

const OPERATING = new Set(['OWNER', 'ADMIN', 'OPERATOR']);

/**
 * Operator resolution of business actions whose outcome is UNCERTAIN (ADR
 * 024): a person checked the connected system and records what they found.
 * Session + CSRF + role checked; the tenant comes from the session.
 */
@Controller('api/v1/inbox/actions')
@UseGuards(SessionGuard)
export class ActionsInboxController {
  constructor(private readonly actions: ActionService) {}

  @Post(':id/resolve')
  @HttpCode(200)
  async resolve(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: unknown,
    @Req() request: InboxRequest,
  ): Promise<{ status: 'ok' }> {
    const principal = request.principal!;
    if (!OPERATING.has(principal.role))
      throw new ForbiddenException({
        code: 'FORBIDDEN',
        message: 'Operator may not do this',
        i18nKey: 'errors.forbidden',
      });
    const parsed = ResolveBody.safeParse(body);
    if (!parsed.success)
      throw new BadRequestException({
        code: 'INVALID_BODY',
        message: 'Invalid body',
        i18nKey: 'errors.invalidBody',
      });
    const result = await this.actions.resolveUncertain({
      tenantId: principal.tenantId,
      proposalId: id,
      outcome: parsed.data.outcome,
      externalId: parsed.data.externalId,
      actor: `operator:${principal.operatorId}`,
    });
    if (result === 'MISSING_EVIDENCE')
      throw new BadRequestException({
        code: 'MISSING_EVIDENCE',
        message: 'The record id is required',
        i18nKey: 'errors.missingEvidence',
      });
    if (result === 'NOT_UNCERTAIN')
      throw new NotFoundException({
        code: 'NOT_UNCERTAIN',
        message: 'No uncertain action',
        i18nKey: 'errors.notUncertain',
      });
    return { status: 'ok' };
  }
}
