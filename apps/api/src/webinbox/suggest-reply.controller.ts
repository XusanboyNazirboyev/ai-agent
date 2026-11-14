import {
  Controller,
  ConflictException,
  BadRequestException,
  ForbiddenException,
  HttpCode,
  HttpException,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  AgentConfigurationError,
  AgentConversationService,
} from '../agent/agent-conversation.service.js';
import { PrismaService } from '../persistence/prisma.service.js';
import { SessionGuard, type InboxRequest } from './session.guard.js';

const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 6;

export interface SuggestedReply {
  /** The text an operator may send; null when the assistant has no suggestion. */
  reply: string | null;
  /** A handover reason code: the assistant itself would hand this over. */
  handover: string | null;
  /** Names of the tools the assistant used. */
  toolsUsed: string[];
  /** The customer message the suggestion answers. */
  basedOnMessageId: string;
}

/**
 * "Assistant suggestion" (ADR 066, UX review D1): on request, the assistant
 * drafts a reply to the customer's last message for the operator to send, edit
 * or ignore. It is the same turn the customer would get (same tools, guardrail
 * and rendering of prices by code) but read only: nothing is stored, nothing is
 * sent, no handover or lead changes. OWNER, ADMIN and OPERATOR only; each call
 * is a paid model call, so a person may ask 6 times a minute.
 */
@Controller('api/v1/inbox/conversations')
@UseGuards(SessionGuard)
export class SuggestReplyController {
  private readonly recent = new Map<string, number[]>();

  constructor(
    private readonly agent: AgentConversationService,
    @Inject(PrismaService) private readonly prisma: PrismaService,
  ) {}

  @Post(':id/suggest-reply')
  @HttpCode(200)
  async suggest(
    @Req() request: InboxRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<SuggestedReply> {
    const principal = request.principal!;
    if (principal.role === 'VIEWER')
      throw new ForbiddenException({
        code: 'FORBIDDEN',
        message: 'Not allowed',
        i18nKey: 'errors.forbidden',
      });
    const conversation = await this.prisma.conversation.findFirst({
      where: { id, tenantId: principal.tenantId },
      select: { id: true, state: true },
    });
    if (!conversation)
      throw new NotFoundException({
        code: 'NOT_FOUND',
        message: 'Conversation not found',
        i18nKey: 'errors.notFound',
      });
    if (conversation.state === 'CLOSED')
      throw new ConflictException({
        code: 'CONVERSATION_CLOSED',
        message: 'The conversation is closed',
        i18nKey: 'errors.CONVERSATION_CLOSED',
      });
    const last = await this.prisma.message.findFirst({
      where: {
        tenantId: principal.tenantId,
        conversationId: id,
        authorType: 'CUSTOMER',
        direction: 'INBOUND',
      },
      orderBy: { sequence: 'desc' },
      select: { id: true, text: true, sequence: true, type: true },
    });
    if (!last || !last.text.trim())
      throw new BadRequestException({
        code: 'NO_CUSTOMER_MESSAGE',
        message: 'The customer has not written anything to answer',
        i18nKey: 'errors.NO_CUSTOMER_MESSAGE',
      });
    this.admit(principal.operatorId);

    let computed;
    try {
      computed = await this.agent.compute({
        tenantId: principal.tenantId,
        conversationId: id,
        turnKey: `suggest-${randomUUID()}`,
        text: last.text,
        beforeSequence: last.sequence,
        readOnly: true,
        fromSpeech: last.type === 'VOICE',
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
    return {
      // A hand-over answer is the assistant saying "a person will answer":
      // useless as a draft for the person, so only the reason is returned.
      reply: result.handover ? null : result.reply,
      handover: result.handover ?? null,
      toolsUsed: [...new Set(result.tools.map((tool) => tool.name))],
      basedOnMessageId: last.id,
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
          code: 'SUGGEST_RATE_LIMITED',
          message: 'Too many suggestions',
          i18nKey: 'errors.SUGGEST_RATE_LIMITED',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    times.push(now);
    this.recent.set(operatorId, times);
  }
}
