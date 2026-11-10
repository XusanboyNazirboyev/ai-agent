import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import type { SubscriptionPlan } from '../generated/prisma/client.js';
import { PrismaService } from '../persistence/prisma.service.js';
import { recordPlatformAudit } from './platform-audit.js';
import {
  conflict,
  isUniqueViolation,
  notFound,
  parseBody,
} from './platform-http.js';
import {
  PlatformSessionGuard,
  type PlatformRequest,
} from './platform-session.guard.js';

const Limits = z
  .object({
    maxOperators: z.number().int().min(0).max(10_000).optional(),
    maxChannelAccounts: z.number().int().min(0).max(10_000).optional(),
    monthlyLlmBudgetUsd: z.number().min(0).max(1_000_000).optional(),
  })
  .strict();

const CreatePlan = z.object({
  code: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,58}[a-z0-9]$/u),
  name: z.string().trim().min(1).max(200),
  priceMinor: z.number().int().min(0).max(1e13),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/u)
    .default('UZS'),
  periodDays: z.number().int().min(1).max(3_660),
  limits: Limits.default({}),
});

const PatchPlan = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    priceMinor: z.number().int().min(0).max(1e13).optional(),
    periodDays: z.number().int().min(1).max(3_660).optional(),
    limits: Limits.optional(),
    isActive: z.boolean().optional(),
  })
  .refine((body) => Object.keys(body).length > 0);

export interface PlanView {
  id: string;
  code: string;
  name: string;
  priceMinor: number;
  currency: string;
  periodDays: number;
  limits: unknown;
  isActive: boolean;
  createdAt: Date;
}

function view(plan: SubscriptionPlan): PlanView {
  return {
    id: plan.id,
    code: plan.code,
    name: plan.name,
    priceMinor: Number(plan.priceMinor),
    currency: plan.currency,
    periodDays: plan.periodDays,
    limits: plan.limits,
    isActive: plan.isActive,
    createdAt: plan.createdAt,
  };
}

/**
 * Subscription plans (ADR 047 §2). Prices are owner decisions entered here,
 * never seeded. Plans are deactivated, never deleted (subscriptions keep
 * pointing at them).
 */
@Controller('api/v1/platform/plans')
@UseGuards(PlatformSessionGuard)
export class PlatformPlansController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async list(): Promise<{ plans: PlanView[] }> {
    const plans = await this.prisma.subscriptionPlan.findMany({
      orderBy: [{ isActive: 'desc' }, { createdAt: 'asc' }],
      take: 200,
    });
    return { plans: plans.map(view) };
  }

  @Post()
  async create(
    @Req() request: PlatformRequest,
    @Body() body: unknown,
  ): Promise<PlanView> {
    const input = parseBody(CreatePlan, body);
    try {
      const plan = await this.prisma.$transaction(async (tx) => {
        const created = await tx.subscriptionPlan.create({
          data: {
            code: input.code,
            name: input.name,
            priceMinor: BigInt(input.priceMinor),
            currency: input.currency,
            periodDays: input.periodDays,
            limits: input.limits,
          },
        });
        await recordPlatformAudit(tx, {
          actorAdminId: request.platform!.adminId,
          action: 'plan.created',
          entityType: 'subscription_plan',
          entityId: created.id,
          summary: {
            code: created.code,
            priceMinor: input.priceMinor,
            currency: created.currency,
            periodDays: created.periodDays,
          },
        });
        return created;
      });
      return view(plan);
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict('PLAN_CODE_TAKEN');
      throw error;
    }
  }

  @Patch(':id')
  async update(
    @Req() request: PlatformRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: unknown,
  ): Promise<PlanView> {
    const input = parseBody(PatchPlan, body);
    const plan = await this.prisma.$transaction(async (tx) => {
      const before = await tx.subscriptionPlan.findUnique({ where: { id } });
      if (!before) throw notFound();
      const updated = await tx.subscriptionPlan.update({
        where: { id },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.priceMinor !== undefined
            ? { priceMinor: BigInt(input.priceMinor) }
            : {}),
          ...(input.periodDays !== undefined
            ? { periodDays: input.periodDays }
            : {}),
          ...(input.limits !== undefined ? { limits: input.limits } : {}),
          ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
        },
      });
      await recordPlatformAudit(tx, {
        actorAdminId: request.platform!.adminId,
        action: input.isActive === false ? 'plan.deactivated' : 'plan.updated',
        entityType: 'subscription_plan',
        entityId: id,
        summary: {
          code: before.code,
          fields: Object.keys(input).sort().join(','),
        },
      });
      return updated;
    });
    return view(plan);
  }
}
