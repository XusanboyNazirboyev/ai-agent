import {
  Body,
  Controller,
  Inject,
  Param,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { TagsService } from '../tags/tags.service.js';
import type { TagView } from '../tags/tag-reads.js';
import { SessionGuard, type InboxRequest } from './session.guard.js';
import { operating, parseId, parseTagIds } from './tag-assignment.js';

/**
 * Tags on a conversation (roadmap P1.8, ADR 071): the workspace's tag
 * dictionary (ADR 053) set on a chat, for sorting the inbox ("delivery",
 * "complaint"). OWNER, ADMIN and OPERATOR set them; tenant from the session.
 */
@Controller('api/v1/inbox/conversations')
@UseGuards(SessionGuard)
export class ConversationTagsController {
  constructor(@Inject(TagsService) private readonly tags: TagsService) {}

  /** Replaces the tag set of a conversation. */
  @Put(':id/tags')
  async setTags(
    @Req() request: InboxRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<{ tags: TagView[] }> {
    const principal = operating(request);
    return this.tags.setTags(
      principal.tenantId,
      principal.operatorId,
      'conversation',
      parseId(id),
      parseTagIds(body),
    );
  }
}
