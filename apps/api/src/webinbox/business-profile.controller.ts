import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Optional,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import type { Prisma } from '../generated/prisma/client.js';
import type { BusinessProfile } from '../core/agent/facts.js';
import {
  businessProfileOf,
  MAX_OWNER_RULE_LENGTH,
  MAX_OWNER_RULES,
  ownerRulesOf,
} from '../agent/business-profile.js';
import {
  BotScheduleSchema,
  botScheduleOf,
  type BotSchedule,
} from '../agent/bot-schedule.js';
import { goLiveGaps, type GoLiveGap } from '../agent/go-live.js';
import { ConnectorSelector } from '../connectors/connector-selector.js';
import { PrismaService } from '../persistence/prisma.service.js';
import { SessionGuard, type InboxRequest } from './session.guard.js';

const Text = (max: number): z.ZodType<string, string> =>
  z
    .string()
    .transform((value) => value.replace(/\s+/gu, ' ').trim())
    .pipe(z.string().max(max));

/** What the owner types in settings; empty text clears a field. */
const ProfileBody = z.object({
  name: Text(200).pipe(z.string().min(2)),
  address: Text(300),
  phone: Text(100),
  hours: Text(300),
  website: Text(200).refine(
    (value) => value === '' || /^https?:\/\/\S+$/iu.test(value),
  ),
});
export type ProfileForm = z.infer<typeof ProfileBody>;

const RulesBody = z.object({
  rules: z.array(Text(MAX_OWNER_RULE_LENGTH)).max(MAX_OWNER_RULES),
});

function form(profile: BusinessProfile): ProfileForm {
  return {
    name: profile.name ?? '',
    address: profile.address ?? '',
    phone: profile.phone ?? '',
    hours: profile.hours ?? '',
    website: profile.website ?? '',
  };
}

@Controller('api/v1/business-profile')
@UseGuards(SessionGuard)
export class BusinessProfileController {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly selector?: ConnectorSelector,
  ) {}

  /** What still keeps the bot from going LIVE (the same check as the switch). */
  @Get('readiness')
  async readiness(
    @Req() request: InboxRequest,
  ): Promise<{ missing: GoLiveGap[] }> {
    if (!this.selector) return { missing: [] };
    return {
      missing: await goLiveGaps(
        this.prisma,
        this.selector,
        request.principal!.tenantId,
        { testAccount: false },
      ),
    };
  }

  @Get()
  async get(@Req() request: InboxRequest): Promise<ProfileForm> {
    const tenant = await this.prisma.tenant.findUniqueOrThrow({
      where: { id: request.principal!.tenantId },
      select: { name: true, config: true },
    });
    return form(businessProfileOf(tenant));
  }

  /** Owner 2026-11-24: the owner's own instructions for the AI agent. */
  @Get('rules')
  async rules(@Req() request: InboxRequest): Promise<{ rules: string[] }> {
    const tenant = await this.prisma.tenant.findUniqueOrThrow({
      where: { id: request.principal!.tenantId },
      select: { config: true },
    });
    return { rules: ownerRulesOf(tenant) };
  }

  /** OWNER/ADMIN only; audited with the count, never the text. */
  @Put('rules')
  async putRules(
    @Req() request: InboxRequest,
    @Body() body: unknown,
  ): Promise<{ rules: string[] }> {
    const principal = request.principal!;
    if (principal.role !== 'OWNER' && principal.role !== 'ADMIN')
      throw new ForbiddenException({
        code: 'FORBIDDEN',
        message: 'Not allowed',
        i18nKey: 'errors.forbidden',
      });
    const parsed = RulesBody.safeParse(body);
    if (!parsed.success)
      throw new BadRequestException({
        code: 'INVALID_BODY',
        message: 'Invalid body',
        i18nKey: 'errors.invalidBody',
      });
    const rules = parsed.data.rules.filter(Boolean);
    return this.prisma.$transaction(async (tx) => {
      const tenant = await tx.tenant.findUniqueOrThrow({
        where: { id: principal.tenantId },
        select: { config: true },
      });
      const saved = await tx.tenant.update({
        where: { id: principal.tenantId },
        data: {
          config: {
            ...((tenant.config as Record<string, unknown> | null) ?? {}),
            agentRules: rules,
          } as Prisma.InputJsonValue,
        },
        select: { config: true },
      });
      await tx.auditEvent.create({
        data: {
          tenantId: principal.tenantId,
          actorType: 'OPERATOR',
          actorId: principal.operatorId,
          action: 'tenant.agent_rules.updated',
          entityType: 'tenant',
          entityId: principal.tenantId,
          safeInputSummary: { count: rules.length },
        },
      });
      return { rules: ownerRulesOf(saved) };
    });
  }

  /** ADR 089: when the bot answers customers. */
  @Get('schedule')
  async schedule(@Req() request: InboxRequest): Promise<BotSchedule> {
    const tenant = await this.prisma.tenant.findUniqueOrThrow({
      where: { id: request.principal!.tenantId },
      select: { config: true },
    });
    return botScheduleOf(tenant.config);
  }

  /** OWNER/ADMIN only; audited. */
  @Put('schedule')
  async putSchedule(
    @Req() request: InboxRequest,
    @Body() body: unknown,
  ): Promise<BotSchedule> {
    const principal = request.principal!;
    if (principal.role !== 'OWNER' && principal.role !== 'ADMIN')
      throw new ForbiddenException({
        code: 'FORBIDDEN',
        message: 'Not allowed',
        i18nKey: 'errors.forbidden',
      });
    const parsed = BotScheduleSchema.safeParse(body);
    if (!parsed.success)
      throw new BadRequestException({
        code: 'INVALID_BODY',
        message: 'Invalid body',
        i18nKey: 'errors.invalidBody',
      });
    const schedule = botScheduleOf({ botSchedule: parsed.data });
    return this.prisma.$transaction(async (tx) => {
      const tenant = await tx.tenant.findUniqueOrThrow({
        where: { id: principal.tenantId },
        select: { config: true },
      });
      await tx.tenant.update({
        where: { id: principal.tenantId },
        data: {
          config: {
            ...((tenant.config as Record<string, unknown> | null) ?? {}),
            botSchedule: schedule,
          } as Prisma.InputJsonValue,
        },
      });
      await tx.auditEvent.create({
        data: {
          tenantId: principal.tenantId,
          actorType: 'OPERATOR',
          actorId: principal.operatorId,
          action: 'tenant.bot_schedule.updated',
          entityType: 'tenant',
          entityId: principal.tenantId,
          safeInputSummary: { ...schedule, days: schedule.days.join(',') },
        },
      });
      return schedule;
    });
  }

  /** OWNER/ADMIN only; audited with field names, never the values. */
  @Put()
  async put(
    @Req() request: InboxRequest,
    @Body() body: unknown,
  ): Promise<ProfileForm> {
    const principal = request.principal!;
    if (principal.role !== 'OWNER' && principal.role !== 'ADMIN')
      throw new ForbiddenException({
        code: 'FORBIDDEN',
        message: 'Not allowed',
        i18nKey: 'errors.forbidden',
      });
    const parsed = ProfileBody.safeParse(body);
    if (!parsed.success)
      throw new BadRequestException({
        code: 'INVALID_BODY',
        message: 'Invalid body',
        i18nKey: 'errors.invalidBody',
      });
    const { name, ...profile } = parsed.data;
    return this.prisma.$transaction(async (tx) => {
      const tenant = await tx.tenant.findUniqueOrThrow({
        where: { id: principal.tenantId },
        select: { config: true },
      });
      const config = {
        ...((tenant.config as Record<string, unknown> | null) ?? {}),
        profile,
      };
      const saved = await tx.tenant.update({
        where: { id: principal.tenantId },
        data: { name, config: config as Prisma.InputJsonValue },
        select: { name: true, config: true },
      });
      await tx.auditEvent.create({
        data: {
          tenantId: principal.tenantId,
          actorType: 'OPERATOR',
          actorId: principal.operatorId,
          action: 'tenant.profile.updated',
          entityType: 'tenant',
          entityId: principal.tenantId,
          safeInputSummary: {
            filled: Object.entries(parsed.data)
              .filter(([, value]) => value !== '')
              .map(([key]) => key)
              .join(','),
          },
        },
      });
      return form(businessProfileOf(saved));
    });
  }
}
