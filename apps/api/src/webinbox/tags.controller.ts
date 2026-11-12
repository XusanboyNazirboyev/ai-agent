import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import {
  TAG_COLORS,
  TAG_NAME_MAX,
  normalizeTagName,
} from '../tags/custom-field-values.js';
import { forbidden, invalidBody, notFound } from '../tags/tag-errors.js';
import { TagsService, type TagItem } from '../tags/tags.service.js';
import { SessionGuard, type InboxRequest } from './session.guard.js';

const Color = z.enum(TAG_COLORS);
const Name = z.string().max(TAG_NAME_MAX * 4);
const CreateBody = z
  .object({ name: Name, color: Color.nullable().optional() })
  .strict();
const UpdateBody = z
  .object({ name: Name.optional(), color: Color.nullable().optional() })
  .strict();
const IdParam = z.string().uuid();

/**
 * Tags (ADR 053). Every signed-in role reads; OWNER and ADMIN manage.
 * Tenant id only from the session principal.
 */
@Controller('api/v1/tags')
@UseGuards(SessionGuard)
export class TagsController {
  constructor(private readonly tags: TagsService) {}

  @Get()
  async list(@Req() request: InboxRequest): Promise<{ items: TagItem[] }> {
    return this.tags.list(request.principal!.tenantId);
  }

  @Post()
  async create(
    @Req() request: InboxRequest,
    @Body() body: unknown,
  ): Promise<TagItem> {
    const principal = manager(request);
    const parsed = CreateBody.safeParse(body);
    const name = parsed.success ? normalizeTagName(parsed.data.name) : null;
    if (!parsed.success || name === null) throw invalidBody();
    return this.tags.create(principal.tenantId, principal.operatorId, {
      name,
      color: parsed.data.color ?? null,
    });
  }

  @Patch(':id')
  async update(
    @Req() request: InboxRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<TagItem> {
    const principal = manager(request);
    const parsedId = IdParam.safeParse(id);
    const parsed = UpdateBody.safeParse(body);
    if (!parsed.success) throw invalidBody();
    const { name: rawName, color } = parsed.data;
    if (rawName === undefined && color === undefined) throw invalidBody();
    const name = rawName === undefined ? undefined : normalizeTagName(rawName);
    if (name === null) throw invalidBody();
    if (!parsedId.success) throw notFound();
    return this.tags.update(
      principal.tenantId,
      principal.operatorId,
      parsedId.data,
      {
        name,
        color,
      },
    );
  }

  @Delete(':id')
  async archive(
    @Req() request: InboxRequest,
    @Param('id') id: string,
  ): Promise<{ id: string }> {
    const principal = manager(request);
    const parsedId = IdParam.safeParse(id);
    if (!parsedId.success) throw notFound();
    return this.tags.archive(
      principal.tenantId,
      principal.operatorId,
      parsedId.data,
    );
  }
}

function manager(
  request: InboxRequest,
): NonNullable<InboxRequest['principal']> {
  const principal = request.principal!;
  if (principal.role !== 'OWNER' && principal.role !== 'ADMIN')
    throw forbidden();
  return principal;
}
