import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import {
  FIELD_KEY_PATTERN,
  FIELD_LABEL_MAX,
  normalizeOptions,
} from '../tags/custom-field-values.js';
import {
  CustomFieldsService,
  type CustomFieldDefItem,
} from '../tags/custom-fields.service.js';
import {
  forbidden,
  invalidBody,
  invalidQuery,
  notFound,
} from '../tags/tag-errors.js';
import { SessionGuard, type InboxRequest } from './session.guard.js';

const Entity = z.enum(['PERSON', 'LEAD']);
const Label = z.string().trim().min(1).max(FIELD_LABEL_MAX);
const ListQuery = z.object({ entity: Entity.optional() });
const CreateBody = z
  .object({
    entity: Entity,
    key: z.string().regex(FIELD_KEY_PATTERN),
    label: Label,
    type: z.enum(['TEXT', 'NUMBER', 'DATE', 'BOOLEAN', 'SELECT']),
    options: z.array(z.string()).optional(),
  })
  .strict();
// key and type are immutable: .strict() rejects them.
const UpdateBody = z
  .object({
    label: Label.optional(),
    options: z.array(z.string()).optional(),
    position: z.number().int().min(0).max(1000).optional(),
  })
  .strict();
const IdParam = z.string().uuid();

/**
 * Custom field definitions (ADR 053). Every signed-in role reads; OWNER and
 * ADMIN manage. Archiving hides a definition and keeps stored values.
 */
@Controller('api/v1/custom-fields')
@UseGuards(SessionGuard)
export class CustomFieldsController {
  constructor(private readonly fields: CustomFieldsService) {}

  @Get()
  async list(
    @Req() request: InboxRequest,
    @Query() query: unknown,
  ): Promise<{ items: CustomFieldDefItem[] }> {
    const parsed = ListQuery.safeParse(query);
    if (!parsed.success) throw invalidQuery();
    return this.fields.list(request.principal!.tenantId, parsed.data.entity);
  }

  @Post()
  async create(
    @Req() request: InboxRequest,
    @Body() body: unknown,
  ): Promise<CustomFieldDefItem> {
    const principal = manager(request);
    const parsed = CreateBody.safeParse(body);
    if (!parsed.success) throw invalidBody();
    const { type, options } = parsed.data;
    let normalized: string[] | null = null;
    if (type === 'SELECT') {
      normalized = normalizeOptions(options);
      if (!normalized) throw invalidBody();
    } else if (options !== undefined) throw invalidBody();
    return this.fields.create(principal.tenantId, principal.operatorId, {
      ...parsed.data,
      options: normalized,
    });
  }

  @Patch(':id')
  async update(
    @Req() request: InboxRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<CustomFieldDefItem> {
    const principal = manager(request);
    const parsed = UpdateBody.safeParse(body);
    if (!parsed.success) throw invalidBody();
    const { label, position, options } = parsed.data;
    if (label === undefined && position === undefined && options === undefined)
      throw invalidBody();
    const normalized =
      options === undefined ? undefined : normalizeOptions(options);
    if (normalized === null) throw invalidBody();
    const parsedId = IdParam.safeParse(id);
    if (!parsedId.success) throw notFound();
    const result = await this.fields.update(
      principal.tenantId,
      principal.operatorId,
      parsedId.data,
      { label, position, options: normalized },
    );
    if (result === 'NOT_SELECT') throw invalidBody();
    return result;
  }

  @Delete(':id')
  async archive(
    @Req() request: InboxRequest,
    @Param('id') id: string,
  ): Promise<{ id: string }> {
    const principal = manager(request);
    const parsedId = IdParam.safeParse(id);
    if (!parsedId.success) throw notFound();
    return this.fields.archive(
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
