import {
  BadRequestException,
  Controller,
  Get,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { PrismaService } from '../persistence/prisma.service.js';
import { SessionGuard, type InboxRequest } from './session.guard.js';

const ListQuery = z.object({
  q: z.string().trim().max(80).optional(),
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(25),
});

export interface ContactListItem {
  id: string;
  name: string | null;
  phone: string | null;
  language: string | null;
  channelType: string;
  marketingOptOut: boolean;
  conversationCount: number;
  /** The most recently active conversation, to open it in the inbox. */
  lastConversationId: string | null;
  lastActivityAt: Date | null;
  createdAt: Date;
}

/**
 * Read-only contact list for the web Contacts page. Tenant-scoped from the
 * session; erased (deleted) contacts are never listed; the provider user id
 * and consent internals stay on the server. Names and phones are customer
 * data: the client renders them as text only.
 */
@Controller('api/v1/contacts')
@UseGuards(SessionGuard)
export class ContactsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async list(
    @Req() request: InboxRequest,
    @Query() query: unknown,
  ): Promise<{ items: ContactListItem[]; nextCursor: string | null }> {
    const parsed = ListQuery.safeParse(query);
    if (!parsed.success)
      throw new BadRequestException({
        code: 'INVALID_QUERY',
        message: 'Invalid query',
        i18nKey: 'errors.invalidQuery',
      });
    const { q, cursor, limit } = parsed.data;
    const rows = await this.prisma.contact.findMany({
      where: {
        tenantId: request.principal!.tenantId,
        deletedAt: null,
        ...(q
          ? {
              OR: [
                { name: { contains: q, mode: 'insensitive' } },
                { phone: { contains: q } },
              ],
            }
          : {}),
      },
      // Ids are time-ordered (uuid v7), so the id is a stable keyset cursor.
      orderBy: { id: 'desc' },
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      include: {
        channelAccount: { select: { channelType: true } },
        conversations: {
          orderBy: { updatedAt: 'desc' },
          take: 1,
          select: { id: true, updatedAt: true },
        },
        _count: { select: { conversations: true } },
      },
    });
    const page = rows.slice(0, limit);
    return {
      items: page.map((row) => ({
        id: row.id,
        name: row.name,
        phone: row.phone,
        language: row.language,
        channelType: row.channelAccount.channelType,
        marketingOptOut: row.marketingOptOut,
        conversationCount: row._count.conversations,
        lastConversationId: row.conversations[0]?.id ?? null,
        lastActivityAt: row.conversations[0]?.updatedAt ?? null,
        createdAt: row.createdAt,
      })),
      nextCursor: rows.length > limit ? page[page.length - 1].id : null,
    };
  }
}
