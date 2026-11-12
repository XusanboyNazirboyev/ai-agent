import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../persistence/prisma.service.js';
import {
  MAX_ACTIVE_TAGS,
  exceedsTagLimit,
  uniqueIds,
} from './custom-field-values.js';
import { conflict, notFound, unknownTag } from './tag-errors.js';
import { tagsOfLeads, tagsOfPersons, type TagView } from './tag-reads.js';

export interface TagItem extends TagView {
  usage: { people: number; leads: number };
}

type Tx = Prisma.TransactionClient;
export type TagTarget = 'person' | 'lead';

const tagSelect = {
  id: true,
  name: true,
  color: true,
  _count: { select: { personTags: true, leadTags: true } },
} as const;

function toItem(row: {
  id: string;
  name: string;
  color: string | null;
  _count: { personTags: number; leadTags: number };
}): TagItem {
  return {
    id: row.id,
    name: row.name,
    color: row.color,
    usage: { people: row._count.personTags, leads: row._count.leadTags },
  };
}

/**
 * Tags of persons and leads (ADR 053). Tenant id always comes from the
 * session principal; every query is tenant-scoped. Tag names and colours are
 * tenant configuration, not personal data, so audit summaries may hold counts
 * and colour tokens but never customer values.
 */
@Injectable()
export class TagsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Active tags with usage counts, in ONE query. */
  async list(tenantId: string): Promise<{ items: TagItem[] }> {
    const rows = await this.prisma.tag.findMany({
      where: { tenantId, archivedAt: null },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      select: tagSelect,
    });
    return { items: rows.map(toItem) };
  }

  async create(
    tenantId: string,
    operatorId: string,
    input: { name: string; color: string | null },
  ): Promise<TagItem> {
    return this.prisma.$transaction(async (tx) => {
      await lockTenant(tx, tenantId);
      const active = await tx.tag.count({
        where: { tenantId, archivedAt: null },
      });
      if (active >= MAX_ACTIVE_TAGS) throw conflict('TAG_LIMIT');
      await assertNameFree(tx, tenantId, input.name, null);
      let created: { id: string };
      try {
        created = await tx.tag.create({
          data: { tenantId, name: input.name, color: input.color },
          select: { id: true },
        });
      } catch (error) {
        if (isUniqueViolation(error)) throw conflict('TAG_EXISTS');
        throw error;
      }
      await audit(tx, tenantId, operatorId, 'tag.created', 'tag', created.id, {
        color: input.color ?? 'none',
      });
      return toItem(
        await tx.tag.findFirstOrThrow({
          where: { tenantId, id: created.id },
          select: tagSelect,
        }),
      );
    });
  }

  async update(
    tenantId: string,
    operatorId: string,
    id: string,
    input: { name?: string; color?: string | null },
  ): Promise<TagItem> {
    return this.prisma.$transaction(async (tx) => {
      await lockTenant(tx, tenantId);
      const tag = await tx.tag.findFirst({
        where: { tenantId, id, archivedAt: null },
        select: { id: true },
      });
      if (!tag) throw notFound();
      if (input.name !== undefined)
        await assertNameFree(tx, tenantId, input.name, id);
      try {
        await tx.tag.update({
          where: { tenantId_id: { tenantId, id } },
          data: {
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.color !== undefined ? { color: input.color } : {}),
          },
        });
      } catch (error) {
        if (isUniqueViolation(error)) throw conflict('TAG_EXISTS');
        throw error;
      }
      await audit(tx, tenantId, operatorId, 'tag.updated', 'tag', id, {
        renamed: input.name !== undefined,
        recolored: input.color !== undefined,
      });
      return toItem(
        await tx.tag.findFirstOrThrow({
          where: { tenantId, id },
          select: tagSelect,
        }),
      );
    });
  }

  /** Archives the tag: hidden everywhere, its join rows are removed. */
  async archive(
    tenantId: string,
    operatorId: string,
    id: string,
  ): Promise<{ id: string }> {
    return this.prisma.$transaction(async (tx) => {
      const tag = await tx.tag.findFirst({
        where: { tenantId, id, archivedAt: null },
        select: { id: true },
      });
      if (!tag) throw notFound();
      await tx.tag.update({
        where: { tenantId_id: { tenantId, id } },
        data: { archivedAt: new Date() },
      });
      const people = await tx.personTag.deleteMany({
        where: { tenantId, tagId: id },
      });
      const leads = await tx.leadTag.deleteMany({
        where: { tenantId, tagId: id },
      });
      await audit(tx, tenantId, operatorId, 'tag.archived', 'tag', id, {
        people: people.count,
        leads: leads.count,
      });
      return { id };
    });
  }

  /**
   * Replaces the tag set of a person or lead. null = not found (unknown,
   * other tenant, merged or erased); throws UNKNOWN_TAG / TAG_LIMIT.
   */
  async setTags(
    tenantId: string,
    operatorId: string,
    target: TagTarget,
    targetId: string,
    tagIds: readonly string[],
  ): Promise<{ tags: TagView[] }> {
    const wanted = uniqueIds(tagIds);
    return this.prisma.$transaction(async (tx) => {
      if (!(await lockVisibleTarget(tx, tenantId, target, targetId)))
        throw notFound();
      const found = wanted.length
        ? await tx.tag.count({
            where: { tenantId, id: { in: wanted }, archivedAt: null },
          })
        : 0;
      if (found !== wanted.length) throw unknownTag();
      if (exceedsTagLimit(wanted.length)) throw conflict('TAG_LIMIT');
      const current =
        target === 'person'
          ? (
              await tx.personTag.findMany({
                where: { tenantId, personId: targetId },
                select: { tagId: true },
              })
            ).map((r) => r.tagId)
          : (
              await tx.leadTag.findMany({
                where: { tenantId, leadId: targetId },
                select: { tagId: true },
              })
            ).map((r) => r.tagId);
      const remove = current.filter((t) => !wanted.includes(t));
      const add = wanted.filter((t) => !current.includes(t));
      if (target === 'person') {
        if (remove.length)
          await tx.personTag.deleteMany({
            where: { tenantId, personId: targetId, tagId: { in: remove } },
          });
        if (add.length)
          await tx.personTag.createMany({
            data: add.map((tagId) => ({ tenantId, personId: targetId, tagId })),
          });
      } else {
        if (remove.length)
          await tx.leadTag.deleteMany({
            where: { tenantId, leadId: targetId, tagId: { in: remove } },
          });
        if (add.length)
          await tx.leadTag.createMany({
            data: add.map((tagId) => ({ tenantId, leadId: targetId, tagId })),
          });
      }
      await audit(
        tx,
        tenantId,
        operatorId,
        `${target}.tags_set`,
        target,
        targetId,
        { added: add.length, removed: remove.length, total: wanted.length },
      );
      const map =
        target === 'person'
          ? await tagsOfPersons(tx, tenantId, [targetId])
          : await tagsOfLeads(tx, tenantId, [targetId]);
      return { tags: map.get(targetId) ?? [] };
    });
  }
}

/** Serialises tag creation and renames of one tenant (limit and name races). */
async function lockTenant(tx: Tx, tenantId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM tenants WHERE id = ${tenantId}::uuid FOR UPDATE`;
}

async function assertNameFree(
  tx: Tx,
  tenantId: string,
  name: string,
  exceptId: string | null,
): Promise<void> {
  const same = await tx.tag.findFirst({
    where: {
      tenantId,
      archivedAt: null,
      name: { equals: name, mode: 'insensitive' },
      ...(exceptId ? { id: { not: exceptId } } : {}),
    },
    select: { id: true },
  });
  if (same) throw conflict('TAG_EXISTS');
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}

/**
 * Locks the person or lead row when it can be edited: a person must be live,
 * not merged away and have a live contact; a lead needs a non-erased contact.
 */
export async function lockVisibleTarget(
  tx: Tx,
  tenantId: string,
  target: TagTarget,
  id: string,
): Promise<boolean> {
  if (target === 'person') {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT p.id FROM persons p
      WHERE p.tenant_id = ${tenantId}::uuid AND p.id = ${id}::uuid
        AND p.deleted_at IS NULL AND p.merged_into_id IS NULL
        AND EXISTS (SELECT 1 FROM contacts c
          WHERE c.tenant_id = p.tenant_id AND c.person_id = p.id
            AND c.deleted_at IS NULL)
      FOR UPDATE OF p`;
    return rows.length === 1;
  }
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT l.id FROM leads l
    JOIN contacts c ON c.tenant_id = l.tenant_id AND c.id = l.contact_id
    WHERE l.tenant_id = ${tenantId}::uuid AND l.id = ${id}::uuid
      AND c.deleted_at IS NULL
    FOR UPDATE OF l`;
  return rows.length === 1;
}

export async function audit(
  tx: Tx,
  tenantId: string,
  operatorId: string,
  action: string,
  entityType: string,
  entityId: string,
  summary: Prisma.InputJsonObject,
): Promise<void> {
  await tx.auditEvent.create({
    data: {
      tenantId,
      actorType: 'OPERATOR',
      actorId: operatorId,
      action,
      entityType,
      entityId,
      safeInputSummary: summary,
    },
  });
}
