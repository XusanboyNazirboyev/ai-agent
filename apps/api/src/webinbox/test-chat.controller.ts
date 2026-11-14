import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  HttpException,
  HttpStatus,
  Inject,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  AgentConfigurationError,
  AgentConversationService,
} from '../agent/agent-conversation.service.js';
import { PrismaService } from '../persistence/prisma.service.js';
import { SessionGuard, type InboxRequest } from './session.guard.js';

const MAX_TEXT = 1_000;
const MAX_HISTORY = 30;
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 10;

const Slots = z
  .record(
    z.string().min(1).max(60),
    z
      .object({
        value: z.union([z.string().max(300), z.number()]),
        source: z.enum(['customer', 'inferred']),
      })
      .strict(),
  )
  .refine((slots) => Object.keys(slots).length <= 20);

const Body_ = z
  .object({
    sessionId: z.uuid(),
    text: z.string().trim().min(1).max(MAX_TEXT),
    history: z
      .array(
        z
          .object({
            role: z.enum(['customer', 'agent']),
            text: z.string().max(2_000),
          })
          .strict(),
      )
      .max(MAX_HISTORY)
      .default([]),
    slots: Slots.default({}),
    language: z.string().max(8).optional(),
    script: z.string().max(8).optional(),
  })
  .strict();

export interface TestChatReply {
  reply: string;
  outcome: string;
  /** A handover reason code: the assistant would pass this chat to a person. */
  handover: string | null;
  language: string | null;
  script: string | null;
  slots: Record<string, { value: string | number; source: string }>;
  /** Names of the tools the assistant used (what it looked up). */
  toolsUsed: string[];
  askedSlot: string | null;
}

/**
 * Try the assistant without a customer (ADR 065, UX review C3). OWNER and ADMIN
 * only. The dialogue lives in the browser: nothing is written to conversations,
 * contacts, leads or handovers, nothing is sent to any channel, and the run is
 * read only; only the model cost is metered, like for any turn. Rate limited
 * per person because every message is a paid model call.
 */
@Controller('api/v1/assistant/test-chat')
@UseGuards(SessionGuard)
export class TestChatController {
  /** Request times per operator (this process; the tenant budget is the hard limit). */
  private readonly recent = new Map<string, number[]>();

  constructor(
    private readonly agent: AgentConversationService,
    @Inject(PrismaService) private readonly prisma: PrismaService,
  ) {}

  @Post()
  @HttpCode(200)
  async send(
    @Req() request: InboxRequest,
    @Body() body: unknown,
  ): Promise<TestChatReply> {
    const principal = request.principal!;
    if (principal.role !== 'OWNER' && principal.role !== 'ADMIN')
      throw new ForbiddenException({
        code: 'FORBIDDEN',
        message: 'Not allowed',
        i18nKey: 'errors.forbidden',
      });
    const parsed = Body_.safeParse(body);
    if (!parsed.success)
      throw new BadRequestException({
        code: 'INVALID_BODY',
        message: 'Invalid body',
        i18nKey: 'errors.invalidBody',
      });
    this.admit(principal.operatorId);
    const input = parsed.data;

    let computed;
    try {
      computed = await this.agent.compute({
        tenantId: principal.tenantId,
        conversationId: input.sessionId,
        turnKey: `test-chat-${randomUUID()}`,
        text: input.text,
        readOnly: true,
        sandbox: {
          history: input.history,
          slots: input.slots,
          ...(input.language ? { language: input.language } : {}),
          ...(input.script ? { script: input.script } : {}),
        },
      });
    } catch (error) {
      if (error instanceof AgentConfigurationError)
        throw new BadRequestException({
          code: 'AGENT_NOT_CONFIGURED',
          message: error.message,
          i18nKey: 'errors.AGENT_NOT_CONFIGURED',
        });
      throw error;
    }
    const { result } = computed;

    // One audit row per test chat (its first message), counts only: it lets
    // the getting-started list know the assistant was tried.
    if (input.history.length === 0)
      await this.prisma.auditEvent.create({
        data: {
          tenantId: principal.tenantId,
          actorType: 'OPERATOR',
          actorId: principal.operatorId,
          action: 'assistant.test_chat_used',
          entityType: 'tenant',
          entityId: principal.tenantId,
          safeInputSummary: { outcome: result.outcome },
        },
      });

    const locale = result.locale.split('-');
    return {
      reply: result.reply,
      outcome: result.outcome,
      handover: result.handover ?? null,
      language: locale[0] ?? null,
      script: locale[1] ?? null,
      slots: Object.fromEntries(
        Object.entries(result.slots).map(([key, entry]) => [
          key,
          { value: entry.value, source: entry.source },
        ]),
      ),
      toolsUsed: [...new Set(result.tools.map((tool) => tool.name))],
      askedSlot: result.askedSlot ?? null,
    };
  }

  private admit(operatorId: string): void {
    const now = Date.now();
    const times = (this.recent.get(operatorId) ?? []).filter(
      (at) => now - at < WINDOW_MS,
    );
    if (times.length >= MAX_PER_WINDOW)
      throw new HttpException(
        {
          code: 'TEST_CHAT_RATE_LIMITED',
          message: 'Too many test messages',
          i18nKey: 'errors.TEST_CHAT_RATE_LIMITED',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    times.push(now);
    this.recent.set(operatorId, times);
  }
}
