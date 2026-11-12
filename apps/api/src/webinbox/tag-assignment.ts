import { z } from 'zod';
import { forbidden, invalidBody, notFound } from '../tags/tag-errors.js';
import type { InboxRequest } from './session.guard.js';

const OPERATING = new Set(['OWNER', 'ADMIN', 'OPERATOR']);
const TagsBody = z
  .object({ tagIds: z.array(z.string().uuid()).max(100) })
  .strict();
const ValuesBody = z
  .object({
    values: z.record(
      z.string().max(64),
      z.union([z.string().max(2000), z.number(), z.boolean(), z.null()]),
    ),
  })
  .strict();
const IdParam = z.string().uuid();

/** Roles that may assign tags and edit values: OWNER, ADMIN, OPERATOR. */
export function operating(
  request: InboxRequest,
): NonNullable<InboxRequest['principal']> {
  const principal = request.principal!;
  if (!OPERATING.has(principal.role)) throw forbidden();
  return principal;
}

export function parseId(id: string): string {
  const parsed = IdParam.safeParse(id);
  if (!parsed.success) throw notFound();
  return parsed.data;
}

export function parseTagIds(body: unknown): string[] {
  const parsed = TagsBody.safeParse(body);
  if (!parsed.success) throw invalidBody();
  return parsed.data.tagIds;
}

export function parseValues(body: unknown): Record<string, unknown> {
  const parsed = ValuesBody.safeParse(body);
  if (!parsed.success) throw invalidBody();
  const keys = Object.keys(parsed.data.values);
  if (keys.length === 0 || keys.length > 50) throw invalidBody();
  return parsed.data.values;
}
