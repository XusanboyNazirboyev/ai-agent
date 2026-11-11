import {
  BadRequestException,
  Controller,
  Get,
  NotFoundException,
  Param,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { PeopleService } from '../persons/people.service.js';
import type { PersonDetail, PersonItem } from '../persons/person-view.js';
import { SessionGuard, type InboxRequest } from './session.guard.js';

const ListQuery = z.object({
  q: z.string().trim().max(80).optional(),
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

const IdParam = z.string().uuid();

/**
 * Read-only People API (ADR 052 slice B). Session-guarded and tenant-scoped
 * from the principal; every signed-in role may read. Erased contacts are
 * never included. Names and phones are customer data: render as text only.
 */
@Controller('api/v1/people')
@UseGuards(SessionGuard)
export class PeopleController {
  constructor(private readonly people: PeopleService) {}

  @Get()
  async list(
    @Req() request: InboxRequest,
    @Query() query: unknown,
  ): Promise<{ items: PersonItem[]; nextCursor: string | null }> {
    const parsed = ListQuery.safeParse(query);
    if (!parsed.success)
      throw new BadRequestException({
        code: 'INVALID_QUERY',
        message: 'Invalid query',
        i18nKey: 'errors.invalidQuery',
      });
    const { q, cursor, limit } = parsed.data;
    return this.people.list(request.principal!.tenantId, {
      q: q || undefined,
      cursor,
      limit,
    });
  }

  @Get(':id')
  async detail(
    @Req() request: InboxRequest,
    @Param('id') id: string,
  ): Promise<PersonDetail> {
    const parsed = IdParam.safeParse(id);
    const found = parsed.success
      ? await this.people.detail(request.principal!.tenantId, parsed.data)
      : null;
    if (!found)
      throw new NotFoundException({
        code: 'NOT_FOUND',
        message: 'Not found',
        i18nKey: 'errors.notFound',
      });
    return found;
  }
}
