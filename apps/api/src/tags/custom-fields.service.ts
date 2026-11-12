import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../persistence/prisma.service.js';
import {
  MAX_ACTIVE_FIELDS,
  applyFieldValues,
  asValues,
  describeFields,
  planFieldValues,
  type FieldType,
  type FieldValue,
} from './custom-field-values.js';
import {
  conflict,
  invalidValue,
  notFound,
  unknownField,
} from './tag-errors.js';
import { activeFieldDefs } from './tag-reads.js';
import { audit, lockVisibleTarget, type TagTarget } from './tags.service.js';

export type FieldEntity = 'PERSON' | 'LEAD';

export interface CustomFieldDefItem {
  id: string;
  entity: FieldEntity;
  key: string;
  label: string;
  type: FieldType;
  options: string[] | null;
  position: number;
}

export interface FieldValueView {
  key: string;
  label: string;
  type: FieldType;
  value: FieldValue | null;
}

type Tx = Prisma.TransactionClient;

const defSelect = {
  id: true,
  entity: true,
  key: true,
  label: true,
  type: true,
  options: true,
  position: true,
} as const;

function toItem(row: {
  id: string;
  entity: FieldEntity;
  key: string;
  label: string;
  type: FieldType;
  options: Prisma.JsonValue;
  position: number;
}): CustomFieldDefItem {
  return {
    ...row,
    options: Array.isArray(row.options) ? (row.options as string[]) : null,
  };
}

/**
 * Custom field definitions and values (ADR 053). Tenant id always comes from
 * the session principal. Audit summaries carry the field key (tenant
 * configuration) and counts, never a stored value.
 */
@Injectable()
export class CustomFieldsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(
    tenantId: string,
    entity?: FieldEntity,
  ): Promise<{ items: CustomFieldDefItem[] }> {
    const rows = await this.prisma.customFieldDef.findMany({
      where: { tenantId, archivedAt: null, ...(entity ? { entity } : {}) },
      orderBy: [
        { entity: 'asc' },
        { position: 'asc' },
        { createdAt: 'asc' },
        { id: 'asc' },
      ],
      select: defSelect,
    });
    return { items: rows.map(toItem) };
  }

  async create(
    tenantId: string,
    operatorId: string,
    input: {
      entity: FieldEntity;
      key: string;
      label: string;
      type: FieldType;
      options: string[] | null;
    },
  ): Promise<CustomFieldDefItem> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM tenants WHERE id = ${tenantId}::uuid FOR UPDATE`;
      const existing = await tx.customFieldDef.findFirst({
        where: { tenantId, entity: input.entity, key: input.key },
        select: { id: true, type: true, archivedAt: true },
      });
      // A key is never reused for another type: stored values may remain.
      if (
        existing &&
        (existing.archivedAt === null || existing.type !== input.type)
      )
        throw conflict('FIELD_KEY_TAKEN');
      const active = await tx.customFieldDef.count({
        where: { tenantId, entity: input.entity, archivedAt: null },
      });
      if (active >= MAX_ACTIVE_FIELDS) throw conflict('FIELD_LIMIT');
      const last = await tx.customFieldDef.findFirst({
        where: { tenantId, entity: input.entity, archivedAt: null },
        orderBy: { position: 'desc' },
        select: { position: true },
      });
      const position = (last?.position ?? -1) + 1;
      const options = input.options ?? Prisma.DbNull;
      const row = existing
        ? await tx.customFieldDef.update({
            where: { tenantId_id: { tenantId, id: existing.id } },
            data: { label: input.label, options, position, archivedAt: null },
            select: defSelect,
          })
        : await tx.customFieldDef.create({
            data: {
              tenantId,
              entity: input.entity,
              key: input.key,
              label: input.label,
              type: input.type,
              options,
              position,
            },
            select: defSelect,
          });
      await audit(
        tx,
        tenantId,
        operatorId,
        'custom_field.created',
        'custom_field',
        row.id,
        {
          entity: input.entity,
          key: input.key,
          type: input.type,
          reactivated: existing !== null,
        },
      );
      return toItem(row);
    });
  }

  async update(
    tenantId: string,
    operatorId: string,
    id: string,
    input: { label?: string; options?: string[]; position?: number },
  ): Promise<CustomFieldDefItem | 'NOT_SELECT'> {
    return this.prisma.$transaction(async (tx) => {
      const def = await tx.customFieldDef.findFirst({
        where: { tenantId, id, archivedAt: null },
        select: { id: true, type: true, key: true, entity: true },
      });
      if (!def) throw notFound();
      if (input.options !== undefined && def.type !== 'SELECT')
        return 'NOT_SELECT' as const;
      const row = await tx.customFieldDef.update({
        where: { tenantId_id: { tenantId, id } },
        data: {
          ...(input.label !== undefined ? { label: input.label } : {}),
          ...(input.options !== undefined ? { options: input.options } : {}),
          ...(input.position !== undefined ? { position: input.position } : {}),
        },
        select: defSelect,
      });
      await audit(
        tx,
        tenantId,
        operatorId,
        'custom_field.updated',
        'custom_field',
        id,
        {
          entity: def.entity,
          key: def.key,
          label: input.label !== undefined,
          options: input.options !== undefined,
          position: input.position !== undefined,
        },
      );
      return toItem(row);
    });
  }

  /** Archives the definition; stored values are kept (never deleted). */
  async archive(
    tenantId: string,
    operatorId: string,
    id: string,
  ): Promise<{ id: string }> {
    return this.prisma.$transaction(async (tx) => {
      const def = await tx.customFieldDef.findFirst({
        where: { tenantId, id, archivedAt: null },
        select: { id: true, key: true, entity: true },
      });
      if (!def) throw notFound();
      await tx.customFieldDef.update({
        where: { tenantId_id: { tenantId, id } },
        data: { archivedAt: new Date() },
      });
      await audit(
        tx,
        tenantId,
        operatorId,
        'custom_field.archived',
        'custom_field',
        id,
        {
          entity: def.entity,
          key: def.key,
        },
      );
      return { id };
    });
  }

  /**
   * Merges a validated `values` patch into the custom fields of a person or
   * lead. UNKNOWN_FIELD / INVALID_VALUE are 400; a missing target is 404.
   */
  async patchValues(
    tenantId: string,
    operatorId: string,
    target: TagTarget,
    targetId: string,
    values: Record<string, unknown>,
  ): Promise<{ customFields: FieldValueView[] }> {
    const entity: FieldEntity = target === 'person' ? 'PERSON' : 'LEAD';
    return this.prisma.$transaction(async (tx) => {
      if (!(await lockVisibleTarget(tx, tenantId, target, targetId)))
        throw notFound();
      const defs = await activeFieldDefs(tx, tenantId, entity);
      const plan = planFieldValues(defs, values);
      if (!plan.ok)
        throw plan.code === 'UNKNOWN_FIELD' ? unknownField() : invalidValue();
      const stored = await this.readStored(tx, tenantId, target, targetId);
      const next = applyFieldValues(asValues(stored), plan);
      const data = { customFields: next as Prisma.InputJsonObject };
      if (target === 'person')
        await tx.person.update({
          where: { tenantId_id: { tenantId, id: targetId } },
          data,
        });
      else
        await tx.lead.update({
          where: { tenantId_id: { tenantId, id: targetId } },
          data,
        });
      await audit(
        tx,
        tenantId,
        operatorId,
        `${target}.custom_fields_set`,
        target,
        targetId,
        { set: Object.keys(plan.set).length, cleared: plan.clear.length },
      );
      return { customFields: describeFields(defs, next) };
    });
  }

  private async readStored(
    tx: Tx,
    tenantId: string,
    target: TagTarget,
    id: string,
  ): Promise<unknown> {
    if (target === 'person')
      return (
        await tx.person.findFirstOrThrow({
          where: { tenantId, id },
          select: { customFields: true },
        })
      ).customFields;
    return (
      await tx.lead.findFirstOrThrow({
        where: { tenantId, id },
        select: { customFields: true },
      })
    ).customFields;
  }
}
