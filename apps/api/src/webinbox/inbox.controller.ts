import {
  BadRequestException,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { SessionGuard, type InboxRequest } from './session.guard.js';
import { InboxReadService } from './inbox-read.service.js';

const ListQuery = z.object({
  scope: z.enum(['waiting', 'mine', 'all', 'closed']).default('waiting'),
  cursor: z.string().max(300).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
  q: z.string().trim().max(80).optional(),
  language: z
    .string()
    .regex(/^[A-Za-z-]{2,16}$/u)
    .optional(),
  leadScore: z.enum(['HOT', 'WARM', 'COLD']).optional(),
});

@Controller('api/v1/inbox')
@UseGuards(SessionGuard)
export class InboxController {
  constructor(private readonly inbox: InboxReadService) {}

  @Get('conversations')
  list(@Req() request: InboxRequest, @Query() query: unknown): unknown {
    const parsed = ListQuery.safeParse(query);
    if (!parsed.success)
      throw new BadRequestException({
        code: 'INVALID_QUERY',
        message: 'Invalid query',
        i18nKey: 'errors.invalidQuery',
      });
    return this.inbox.list(request.principal!, parsed.data);
  }

  @Get('conversations/:id')
  async view(
    @Req() request: InboxRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<unknown> {
    const result = await this.inbox.view(request.principal!, id);
    if (!result)
      throw new NotFoundException({
        code: 'NOT_FOUND',
        message: 'Conversation not found',
        i18nKey: 'errors.notFound',
      });
    return result;
  }
}
