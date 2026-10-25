import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Headers,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { OperatorRequestGuard } from './operator-request-guard.js';
import { HandoverService, type CommandResult } from './handover.service.js';
import { type AuthenticatedOperator } from './operator-auth.js';

export interface CommandResponse {
  status: 'ok' | 'duplicate';
  handoverId: string;
  state?: string;
  messageId?: string;
}

const KEY = z
  .string()
  .min(8)
  .max(200)
  .regex(/^[\x21-\x7e]+$/u);
const TEXT = z.object({ text: z.string().min(1).max(4_096) }).strict();

function error(
  code: string,
  message: string,
  details?: unknown,
): Record<string, unknown> {
  return {
    code,
    message,
    i18nKey: `errors.${code.toLowerCase()}`,
    ...(details === undefined ? {} : { details }),
  };
}

/**
 * Operator command API (spec §12A.2): the same commands as the Telegram
 * group, over REST. Authentication resolves tenant and operator from the
 * credential, every call needs an `Idempotency-Key` header, and the result is
 * the HandoverService outcome: a repeated key answers 200 `duplicate`, a lost
 * take-over race answers 409. Full session auth, CSRF and the role matrix of
 * the web inbox are Phase 6A.
 */
const LEAD_STATUS = z.object({
  status: z.enum(['NEW', 'IN_PROGRESS', 'WON', 'LOST']),
});

@Controller('api/v1/handovers')
@UseGuards(OperatorRequestGuard)
export class OperatorCommandsController {
  constructor(private readonly handovers: HandoverService) {}

  private key(header: string | undefined): string {
    const parsed = KEY.safeParse(header);
    if (!parsed.success)
      throw new BadRequestException(
        error(
          'IDEMPOTENCY_KEY_REQUIRED',
          'Idempotency-Key header (8-200 printable characters) is required',
        ),
      );
    return parsed.data;
  }

  private text(body: unknown): string {
    const parsed = TEXT.safeParse(body);
    if (!parsed.success)
      throw new BadRequestException(
        error('INVALID_BODY', 'Body must be { "text": 1-4096 characters }'),
      );
    return parsed.data.text;
  }

  private outcome(result: CommandResult): CommandResponse {
    if (result.status === 'OK')
      return {
        status: 'ok',
        handoverId: result.handoverId,
        state: result.state,
        ...(result.messageId ? { messageId: result.messageId } : {}),
      };
    if (result.status === 'DUPLICATE')
      return { status: 'duplicate', handoverId: result.handoverId };
    switch (result.code) {
      case 'NOT_FOUND':
        throw new NotFoundException(error('NOT_FOUND', 'Handover not found'));
      case 'FORBIDDEN':
        throw new ForbiddenException(
          error('FORBIDDEN', 'Operator may not do this'),
        );
      case 'NO_LEAD':
        throw new ConflictException(
          error('NO_LEAD', 'This conversation has no lead yet'),
        );
      case 'EMPTY_TEXT':
        throw new BadRequestException(
          error('INVALID_BODY', 'Text must not be empty'),
        );
      case 'ALREADY_TAKEN':
        throw new ConflictException(
          error(
            'ALREADY_TAKEN',
            'Another operator already took this conversation',
          ),
        );
      case 'NOT_ASSIGNED':
        throw new ConflictException(
          error('NOT_ASSIGNED', 'The conversation belongs to another operator'),
        );
      default:
        throw new ConflictException(
          error('ILLEGAL_STATE', 'Not possible in the current state'),
        );
    }
  }

  private base(
    operator: AuthenticatedOperator,
    id: string,
    key: string | undefined,
  ): {
    tenantId: string;
    handoverId: string;
    operatorId: string;
    idempotencyKey: string;
  } {
    return {
      tenantId: operator.tenantId,
      handoverId: id,
      operatorId: operator.operatorId,
      idempotencyKey: `api:${this.key(key)}`,
    };
  }

  @Post(':id/take-over')
  @HttpCode(200)
  async takeOver(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: { operator: AuthenticatedOperator },
  ): Promise<CommandResponse> {
    return this.outcome(
      await this.handovers.takeOver(this.base(request.operator, id, key)),
    );
  }

  @Post(':id/return-to-bot')
  @HttpCode(200)
  async returnToBot(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: { operator: AuthenticatedOperator },
  ): Promise<CommandResponse> {
    return this.outcome(
      await this.handovers.returnToBot(this.base(request.operator, id, key)),
    );
  }

  @Post(':id/close')
  @HttpCode(200)
  async close(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: { operator: AuthenticatedOperator },
  ): Promise<CommandResponse> {
    return this.outcome(
      await this.handovers.close(this.base(request.operator, id, key)),
    );
  }

  @Post(':id/reply')
  @HttpCode(200)
  async reply(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: unknown,
    @Req() request: { operator: AuthenticatedOperator },
  ): Promise<CommandResponse> {
    return this.outcome(
      await this.handovers.reply({
        ...this.base(request.operator, id, key),
        text: this.text(body),
      }),
    );
  }

  @Post(':id/notes')
  @HttpCode(200)
  async note(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: unknown,
    @Req() request: { operator: AuthenticatedOperator },
  ): Promise<CommandResponse> {
    return this.outcome(
      await this.handovers.addNote({
        ...this.base(request.operator, id, key),
        text: this.text(body),
      }),
    );
  }

  @Post(':id/lead-status')
  @HttpCode(200)
  async leadStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: unknown,
    @Req() request: { operator: AuthenticatedOperator },
  ): Promise<CommandResponse> {
    const parsed = LEAD_STATUS.safeParse(body);
    if (!parsed.success)
      throw new BadRequestException(
        error(
          'INVALID_BODY',
          'Body must be { "status": "NEW" | "IN_PROGRESS" | "WON" | "LOST" }',
        ),
      );
    return this.outcome(
      await this.handovers.setLeadStatus({
        ...this.base(request.operator, id, key),
        status: parsed.data.status,
      }),
    );
  }
}
