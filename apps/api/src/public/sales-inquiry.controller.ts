import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpException,
  Post,
  Req,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';
import type { AppEnvironment } from '../config/environment.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import { PrivilegedDatabase } from '../persistence/privileged-database.js';
import { PlatformBotSender } from '../signup/platform-bot.sender.js';
import { LoginRateLimiter } from '../webinbox/auth.controller.js';
import {
  loginClientAddress,
  type AddressedRequest,
} from '../webinbox/client-address.js';

const Text = (max: number): z.ZodType<string, string> =>
  z
    .string()
    .transform((value) => value.replace(/\s+/gu, ' ').trim())
    .pipe(z.string().max(max));

const InquiryBody = z.object({
  name: Text(80).pipe(z.string().min(2)),
  phone: Text(32).pipe(z.string().regex(/^\+?[\d\s()-]{7,32}$/u)),
  company: Text(120).optional(),
  message: Text(500).optional(),
  locale: z.enum(['uz-Latn', 'ru', 'en']).optional(),
  /** Hidden field people never fill; a bot that fills it is told "ok". */
  website: z.string().max(200).optional(),
});

/** The chat message: plain text (no parse mode), so customer text stays text. */
export function inquiryText(inquiry: {
  name: string;
  phone: string;
  company?: string | undefined;
  message?: string | undefined;
}): string {
  return [
    'tezda: new request from the website',
    `Name: ${inquiry.name}`,
    `Phone: ${inquiry.phone}`,
    inquiry.company ? `Company: ${inquiry.company}` : null,
    inquiry.message ? `Message: ${inquiry.message}` : null,
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Owner 2026-11-24: the sales page's "contact us" form. Stored first, then
 * sent to SALES_INQUIRY_CHAT_ID by the platform bot (best effort; `notified`
 * records whether it arrived). No session; 5 requests per address an hour.
 */
@Controller('api/v1/public/inquiries')
export class SalesInquiryController {
  private readonly limiter = new LoginRateLimiter(5, 60 * 60 * 1000);
  // Platform table without tenant data, before any session (as signups).
  private readonly prisma: PrismaClient;

  constructor(
    privileged: PrivilegedDatabase,
    private readonly config: ConfigService<AppEnvironment, true>,
    private readonly bot: PlatformBotSender,
  ) {
    this.prisma = privileged.db;
  }

  @Post()
  @HttpCode(201)
  async create(
    @Req() request: AddressedRequest,
    @Body() body: unknown,
  ): Promise<{ ok: true }> {
    const allowed = this.limiter.allow(
      loginClientAddress(
        request,
        this.config.get('WEB_PROXY_SECRET', { infer: true }),
      ),
    );
    if (!allowed)
      throw new HttpException(
        {
          code: 'RATE_LIMITED',
          message: 'Too many requests',
          i18nKey: 'errors.rateLimited',
        },
        429,
      );
    const parsed = InquiryBody.safeParse(body);
    if (!parsed.success)
      throw new BadRequestException({
        code: 'INVALID_BODY',
        message: 'Invalid body',
        i18nKey: 'errors.invalidBody',
      });
    const { website, ...inquiry } = parsed.data;
    if (website) return { ok: true };
    const company = inquiry.company || null;
    const message = inquiry.message || null;
    const row = await this.prisma.salesInquiry.create({
      data: {
        name: inquiry.name,
        phone: inquiry.phone,
        company,
        message,
        locale: inquiry.locale ?? null,
      },
      select: { id: true },
    });
    const chatId = this.config.get('SALES_INQUIRY_CHAT_ID', { infer: true });
    if (chatId && (await this.bot.send(chatId, inquiryText(inquiry))))
      await this.prisma.salesInquiry.update({
        where: { id: row.id },
        data: { notified: true },
      });
    return { ok: true };
  }
}
