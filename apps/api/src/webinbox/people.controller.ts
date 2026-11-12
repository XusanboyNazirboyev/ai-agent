import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { PeopleService } from '../persons/people.service.js';
import {
  PersonErasureService,
  type PersonErasureResult,
} from '../persons/person-erasure.service.js';
import {
  MergeRefusedError,
  PersonMergeService,
  PersonNotFoundError,
  SamePersonError,
  UnmergeBlockedError,
  type MergePreview,
} from '../persons/person-merge.service.js';
import type { PersonDetail, PersonItem } from '../persons/person-view.js';
import { SessionGuard, type InboxRequest } from './session.guard.js';

const ListQuery = z.object({
  q: z.string().trim().max(80).optional(),
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

const IdParam = z.string().uuid();
const PreviewQuery = z.object({ intoId: z.string().uuid() });
const MergeBody = z.object({
  intoId: z.string().uuid(),
  reason: z.string().trim().min(3).max(500),
});

const notFound = (): NotFoundException =>
  new NotFoundException({
    code: 'NOT_FOUND',
    message: 'Not found',
    i18nKey: 'errors.notFound',
  });
const forbidden = (): ForbiddenException =>
  new ForbiddenException({
    code: 'FORBIDDEN',
    message: 'Not allowed',
    i18nKey: 'errors.forbidden',
  });
const samePerson = (): BadRequestException =>
  new BadRequestException({
    code: 'SAME_PERSON',
    message: 'A person cannot be merged into itself',
    i18nKey: 'errors.samePerson',
  });

/** Maps the merge service errors to the HTTP error contract. */
function mapMergeError(error: unknown): never {
  if (error instanceof PersonNotFoundError) throw notFound();
  if (error instanceof SamePersonError) throw samePerson();
  if (error instanceof MergeRefusedError)
    throw new ConflictException({
      code: 'MERGE_REFUSED',
      message: 'These people cannot be merged',
      i18nKey: 'errors.mergeRefused',
    });
  if (error instanceof UnmergeBlockedError)
    throw new ConflictException({
      code: 'UNMERGE_BLOCKED',
      message: 'This merge can no longer be undone',
      i18nKey: 'errors.unmergeBlocked',
    });
  throw error;
}

/**
 * People API (ADR 052 slices B-D). Session-guarded and tenant-scoped from the
 * principal; every signed-in role may read. Merge, preview and unmerge need
 * ADMIN or OWNER; erasing a person needs OWNER. Erased contacts are
 * never included. Names and phones are customer data: render as text only.
 */
@Controller('api/v1/people')
@UseGuards(SessionGuard)
export class PeopleController {
  constructor(
    private readonly people: PeopleService,
    private readonly merges: PersonMergeService,
    private readonly erasure: PersonErasureService,
  ) {}

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

  // Declared before `:id` so "duplicates" is not read as an id.
  @Get('duplicates')
  async duplicateGroups(@Req() request: InboxRequest): Promise<{
    groups: Array<{ reason: 'PHONE'; persons: PersonItem[] }>;
  }> {
    return {
      groups: await this.people.duplicateGroups(request.principal!.tenantId),
    };
  }

  @Get(':id/duplicates')
  async duplicatesOf(
    @Req() request: InboxRequest,
    @Param('id') id: string,
  ): Promise<{ items: PersonItem[] }> {
    const parsed = IdParam.safeParse(id);
    const items = parsed.success
      ? await this.people.duplicatesOf(request.principal!.tenantId, parsed.data)
      : null;
    if (!items) throw notFound();
    return { items };
  }

  @Get(':id/merge-preview')
  async mergePreview(
    @Req() request: InboxRequest,
    @Param('id') id: string,
    @Query() query: unknown,
  ): Promise<MergePreview> {
    const principal = request.principal!;
    if (principal.role !== 'OWNER' && principal.role !== 'ADMIN')
      throw forbidden();
    const parsedQuery = PreviewQuery.safeParse(query);
    if (!parsedQuery.success)
      throw new BadRequestException({
        code: 'INVALID_QUERY',
        message: 'Invalid query',
        i18nKey: 'errors.invalidQuery',
      });
    const parsedId = IdParam.safeParse(id);
    if (!parsedId.success) throw notFound();
    try {
      return await this.merges.preview(
        principal.tenantId,
        parsedId.data,
        parsedQuery.data.intoId,
      );
    } catch (error) {
      return mapMergeError(error);
    }
  }

  @Post(':id/merge')
  async merge(
    @Req() request: InboxRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<{ mergeId: string; survivor: PersonDetail }> {
    const principal = request.principal!;
    if (principal.role !== 'OWNER' && principal.role !== 'ADMIN')
      throw forbidden();
    const parsedBody = MergeBody.safeParse(body);
    if (!parsedBody.success)
      throw new BadRequestException({
        code: 'INVALID_BODY',
        message: 'Invalid body',
        i18nKey: 'errors.invalidBody',
      });
    const parsedId = IdParam.safeParse(id);
    if (!parsedId.success) throw notFound();
    try {
      return await this.merges.merge(
        principal.tenantId,
        parsedId.data,
        parsedBody.data.intoId,
        parsedBody.data.reason,
        principal.operatorId,
      );
    } catch (error) {
      return mapMergeError(error);
    }
  }

  @Post(':id/unmerge')
  async unmerge(
    @Req() request: InboxRequest,
    @Param('id') id: string,
  ): Promise<{
    mergeId: string;
    survivor: PersonDetail;
    restored: PersonItem;
  }> {
    const principal = request.principal!;
    if (principal.role !== 'OWNER' && principal.role !== 'ADMIN')
      throw forbidden();
    const parsedId = IdParam.safeParse(id);
    if (!parsedId.success) throw notFound();
    try {
      return await this.merges.unmerge(
        principal.tenantId,
        parsedId.data,
        principal.operatorId,
      );
    } catch (error) {
      return mapMergeError(error);
    }
  }

  /** Owner-initiated erasure of a whole person (ADR 052 slice D). */
  @Delete(':id')
  async erase(
    @Req() request: InboxRequest,
    @Param('id') id: string,
  ): Promise<PersonErasureResult> {
    const principal = request.principal!;
    if (principal.role !== 'OWNER') throw forbidden();
    const parsedId = IdParam.safeParse(id);
    if (!parsedId.success) throw notFound();
    try {
      return await this.erasure.erase(
        principal.tenantId,
        parsedId.data,
        principal.operatorId,
      );
    } catch (error) {
      return mapMergeError(error);
    }
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
    if (!found) throw notFound();
    return found;
  }
}
