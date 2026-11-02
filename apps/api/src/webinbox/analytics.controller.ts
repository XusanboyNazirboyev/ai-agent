import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import {
  AnalyticsService,
  RangeError_,
  type AnalyticsReport,
} from './analytics.service.js';
import { SessionGuard, type InboxRequest } from './session.guard.js';

const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u);
const Query_ = z.object({ from: Day.optional(), to: Day.optional() });

/**
 * Read-only metrics for the web Analytics page (Section 11, 12A.6). OWNER and
 * ADMIN only (owners and managers); tenant from the session; no customer text.
 */
@Controller('api/v1/analytics')
@UseGuards(SessionGuard)
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get()
  async report(
    @Req() request: InboxRequest,
    @Query() query: unknown,
  ): Promise<AnalyticsReport> {
    const principal = request.principal!;
    if (principal.role !== 'OWNER' && principal.role !== 'ADMIN')
      throw new ForbiddenException({
        code: 'FORBIDDEN',
        message: 'Not allowed',
        i18nKey: 'errors.forbidden',
      });
    const parsed = Query_.safeParse(query);
    if (!parsed.success)
      throw new BadRequestException({
        code: 'INVALID_QUERY',
        message: 'Invalid query',
        i18nKey: 'errors.invalidQuery',
      });
    try {
      return await this.analytics.report(principal.tenantId, parsed.data);
    } catch (error) {
      if (error instanceof RangeError_)
        throw new BadRequestException({
          code: 'INVALID_RANGE',
          message: 'Invalid date range',
          i18nKey: 'errors.invalidRange',
        });
      throw error;
    }
  }
}
