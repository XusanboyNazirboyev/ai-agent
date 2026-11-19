import { z } from 'zod';
import type { Prisma } from '../generated/prisma/client.js';
import { isCalendarDate, toDateOnly } from './pipeline-rules.js';

/**
 * Lead filters shared by the leads list and the funnel board (ADR 076), so a
 * column's count always matches the leads the column lists.
 */
export const LeadFilterQuery = z.object({
  /** An operator id, or `none` for leads without an owner. */
  ownerOperatorId: z.union([z.string().uuid(), z.literal('none')]).optional(),
  source: z.string().trim().min(1).max(60).optional(),
  closeBefore: z.string().refine(isCalendarDate).optional(),
  closeAfter: z.string().refine(isCalendarDate).optional(),
  tagId: z.string().uuid().optional(),
  /** Creation date range, inclusive calendar days (UTC). */
  from: z.string().refine(isCalendarDate).optional(),
  to: z.string().refine(isCalendarDate).optional(),
  /** Customer name, or 3+ digits of the phone number. */
  q: z.string().trim().min(1).max(80).optional(),
  /** `channelType` of the conversation's channel account. */
  channel: z
    .string()
    .regex(/^[a-z_]{1,40}$/u)
    .optional(),
  score: z.enum(['HOT', 'WARM', 'COLD']).optional(),
  /** `none`: no open task; `overdue`: an open task past its due time. */
  task: z.enum(['none', 'overdue']).optional(),
});

export type LeadFilterInput = z.infer<typeof LeadFilterQuery>;

const DAY_MS = 86_400_000;
const MIN_PHONE_DIGITS = 3;

/** Prisma conditions of the filters (tenant scope comes from the caller). */
export function leadFilterWhere(
  tenantId: string,
  filters: LeadFilterInput,
  now: Date,
): Prisma.LeadWhereInput {
  const {
    ownerOperatorId,
    source,
    closeBefore,
    closeAfter,
    tagId,
    from,
    to,
    q,
    channel,
    score,
    task,
  } = filters;
  const and: Prisma.LeadWhereInput[] = [];
  if (ownerOperatorId)
    and.push({
      ownerOperatorId: ownerOperatorId === 'none' ? null : ownerOperatorId,
    });
  if (source) and.push({ source: { equals: source, mode: 'insensitive' } });
  if (closeBefore || closeAfter)
    and.push({
      expectedCloseDate: {
        ...(closeBefore ? { lte: toDateOnly(closeBefore) } : {}),
        ...(closeAfter ? { gte: toDateOnly(closeAfter) } : {}),
      },
    });
  if (tagId) and.push({ tags: { some: { tenantId, tagId } } });
  if (from || to)
    and.push({
      createdAt: {
        ...(from ? { gte: toDateOnly(from) } : {}),
        ...(to ? { lt: new Date(toDateOnly(to).getTime() + DAY_MS) } : {}),
      },
    });
  if (q) {
    const digits = q.replace(/\D/gu, '');
    and.push({
      OR: [
        { contact: { name: { contains: q, mode: 'insensitive' } } },
        ...(digits.length >= MIN_PHONE_DIGITS
          ? [{ contact: { phone: { contains: digits } } }]
          : []),
      ],
    });
  }
  if (channel)
    and.push({ conversation: { channelAccount: { channelType: channel } } });
  if (score) and.push({ score });
  if (task === 'none')
    and.push({ tasks: { none: { tenantId, doneAt: null } } });
  if (task === 'overdue')
    and.push({
      tasks: { some: { tenantId, doneAt: null, dueAt: { lt: now } } },
    });
  return and.length === 0 ? {} : { AND: and };
}
