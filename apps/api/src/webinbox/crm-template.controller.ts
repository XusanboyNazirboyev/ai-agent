import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Inject,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { CrmTemplate } from '@agentcore/shared';
import { z } from 'zod';
import { ensureDefaultPipeline } from '../leads/lead-stage.util.js';
import { DOMAIN_PACKS } from '../packs/registry.js';
import { PrismaService } from '../persistence/prisma.service.js';
import { MAX_PIPELINES } from '../pipelines/pipeline-rules.js';
import {
  MAX_ACTIVE_FIELDS,
  MAX_ACTIVE_TAGS,
} from '../tags/custom-field-values.js';
import { SessionGuard, type InboxRequest } from './session.guard.js';

export interface CrmTemplateView {
  available: boolean;
  key?: string;
  /** In the workspace language. */
  pipelineName?: string;
  stages?: Array<{ code: string; kind: 'OPEN' | 'WON' | 'LOST' }>;
  leadFields?: Array<{
    key: string;
    type: string;
    label: string;
    exists: boolean;
  }>;
  tags?: Array<{ name: string; color: string | null; exists: boolean }>;
  /** A pipeline of this name is already there: applying adds only what is missing. */
  pipelineExists?: boolean;
}

export interface CrmTemplateResult {
  pipelineId: string;
  created: { pipeline: boolean; fields: number; tags: number };
  madeDefault: boolean;
}

const ApplyBody = z.object({ makeDefault: z.boolean() }).strict();

/** The text of the workspace language, else English, else the first one. */
function local(text: Partial<Record<string, string>>, locale: string): string {
  return text[locale] ?? text.en ?? Object.values(text).find(Boolean) ?? '';
}

/**
 * A ready set of sales stages, lead fields and tags from the workspace's
 * domain pack (UX review step 7; for travel, the tourism template). Read for
 * everyone who manages settings; applied only on purpose by an owner or admin,
 * in one transaction, adding only what is missing: existing pipelines, stages,
 * fields, tags and leads are never changed, except that the new pipeline
 * becomes the default when asked.
 */
@Controller('api/v1/crm-template')
@UseGuards(SessionGuard)
export class CrmTemplateController {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

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

  private async template(
    tenantId: string,
  ): Promise<{ template: CrmTemplate; locale: string } | null> {
    const tenant = await this.prisma.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      select: { packKey: true, packVersion: true, defaultLocale: true },
    });
    const pack = DOMAIN_PACKS.get(`${tenant.packKey}@${tenant.packVersion}`);
    return pack?.crmTemplate
      ? { template: pack.crmTemplate, locale: tenant.defaultLocale }
      : null;
  }

  @Get()
  async view(@Req() request: InboxRequest): Promise<CrmTemplateView> {
    const { tenantId } = this.manager(request);
    const found = await this.template(tenantId);
    if (!found) return { available: false };
    const { template, locale } = found;
    const pipelineName = local(template.pipelineName, locale);
    const [pipeline, fields, tags] = await Promise.all([
      this.prisma.pipeline.findFirst({
        where: { tenantId, archivedAt: null, name: pipelineName },
        select: { id: true },
      }),
      this.prisma.customFieldDef.findMany({
        where: { tenantId, entity: 'LEAD' },
        select: { key: true },
      }),
      this.prisma.tag.findMany({
        where: { tenantId, archivedAt: null },
        select: { name: true },
      }),
    ]);
    const fieldKeys = new Set(fields.map((f) => f.key));
    const tagNames = new Set(tags.map((t) => t.name.toLocaleLowerCase()));
    return {
      available: true,
      key: template.key,
      pipelineName,
      pipelineExists: pipeline !== null,
      stages: template.stages.map((s) => ({ code: s.code, kind: s.kind })),
      leadFields: template.leadFields.map((f) => ({
        key: f.key,
        type: f.type,
        label: local(f.label, locale),
        exists: fieldKeys.has(f.key),
      })),
      tags: template.tags.map((t) => {
        const name = local(t.name, locale);
        return {
          name,
          color: t.color ?? null,
          exists: tagNames.has(name.toLocaleLowerCase()),
        };
      }),
    };
  }

  @Post('apply')
  @HttpCode(200)
  async apply(
    @Req() request: InboxRequest,
    @Body() body: unknown,
  ): Promise<CrmTemplateResult> {
    const who = this.manager(request);
    const parsed = ApplyBody.safeParse(body);
    if (!parsed.success)
      throw new BadRequestException({
        code: 'INVALID_BODY',
        message: 'Send {"makeDefault": true|false}',
        i18nKey: 'errors.invalidBody',
      });
    const found = await this.template(who.tenantId);
    if (!found)
      throw new BadRequestException({
        code: 'NO_TEMPLATE',
        message: 'This workspace has no ready template',
        i18nKey: 'errors.NO_TEMPLATE',
      });
    const { template, locale } = found;
    const tenantId = who.tenantId;
    const pipelineName = local(template.pipelineName, locale);

    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "tenants" WHERE "id" = ${tenantId}::uuid FOR UPDATE`;
      await ensureDefaultPipeline(tx, tenantId);

      // 1. The pipeline and its stages (only when there is none of that name).
      let pipeline = await tx.pipeline.findFirst({
        where: { tenantId, archivedAt: null, name: pipelineName },
        select: { id: true, isDefault: true },
      });
      const pipelineCreated = pipeline === null;
      if (!pipeline) {
        const active = await tx.pipeline.findMany({
          where: { tenantId, archivedAt: null },
          select: { position: true },
        });
        if (active.length >= MAX_PIPELINES)
          throw new ConflictException({
            code: 'PIPELINE_LIMIT',
            message: 'Maximum number of pipelines reached',
            i18nKey: 'errors.PIPELINE_LIMIT',
          });
        const created = await tx.pipeline.create({
          data: {
            tenantId,
            name: pipelineName,
            position: Math.max(0, ...active.map((p) => p.position)) + 1,
            aiStaging: 'AUTO',
          },
          select: { id: true, isDefault: true },
        });
        await tx.leadStage.createMany({
          data: template.stages.map((stage, position) => ({
            tenantId,
            pipelineId: created.id,
            code: stage.code,
            kind: stage.kind,
            position,
          })),
        });
        pipeline = created;
      }

      // 2. The new pipeline takes new leads, when asked.
      let madeDefault = false;
      if (parsed.data.makeDefault && !pipeline.isDefault) {
        // The old default keeps a stored name (only the default is unnamed).
        await tx.pipeline.updateMany({
          where: { tenantId, isDefault: true, archivedAt: null, name: null },
          data: { name: 'Sales' },
        });
        await tx.pipeline.updateMany({
          where: { tenantId, isDefault: true, archivedAt: null },
          data: { isDefault: false },
        });
        await tx.pipeline.updateMany({
          where: { tenantId, id: pipeline.id },
          data: { isDefault: true },
        });
        madeDefault = true;
      }

      // 3. Lead fields that are not there yet (an archived one counts as there).
      const fields = await tx.customFieldDef.findMany({
        where: { tenantId, entity: 'LEAD' },
        select: { key: true, archivedAt: true, position: true },
      });
      const fieldKeys = new Set(fields.map((f) => f.key));
      let activeFields = fields.filter((f) => f.archivedAt === null).length;
      let position = Math.max(-1, ...fields.map((f) => f.position)) + 1;
      let fieldsCreated = 0;
      for (const field of template.leadFields) {
        if (fieldKeys.has(field.key) || activeFields >= MAX_ACTIVE_FIELDS)
          continue;
        await tx.customFieldDef.create({
          data: {
            tenantId,
            entity: 'LEAD',
            key: field.key,
            label: local(field.label, locale),
            type: field.type,
            position,
          },
        });
        position += 1;
        activeFields += 1;
        fieldsCreated += 1;
      }

      // 4. Tags whose name is free (names compare without case).
      const tags = await tx.tag.findMany({
        where: { tenantId, archivedAt: null },
        select: { name: true },
      });
      const taken = new Set(tags.map((t) => t.name.toLocaleLowerCase()));
      let tagsCreated = 0;
      for (const tag of template.tags) {
        const name = local(tag.name, locale);
        if (taken.has(name.toLocaleLowerCase())) continue;
        if (tags.length + tagsCreated >= MAX_ACTIVE_TAGS) break;
        await tx.tag.create({
          data: { tenantId, name, color: tag.color ?? null },
        });
        taken.add(name.toLocaleLowerCase());
        tagsCreated += 1;
      }

      await tx.auditEvent.create({
        data: {
          tenantId,
          actorType: 'OPERATOR',
          actorId: who.operatorId,
          action: 'crm_template.applied',
          entityType: 'pipeline',
          entityId: pipeline.id,
          safeInputSummary: {
            template: template.key,
            pipelineCreated,
            fieldsCreated,
            tagsCreated,
            madeDefault,
          },
        },
      });
      return {
        pipelineId: pipeline.id,
        created: {
          pipeline: pipelineCreated,
          fields: fieldsCreated,
          tags: tagsCreated,
        },
        madeDefault,
      };
    });
  }
}
