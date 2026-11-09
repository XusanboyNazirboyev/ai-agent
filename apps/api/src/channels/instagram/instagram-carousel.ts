import { z } from 'zod';
import type { Fact } from '../../core/agent/facts.js';

/**
 * ADR 044: an Instagram generic template ("carousel") of the catalog items a
 * reply showed. Built by code from this turn's validated title facts, never
 * by the model. Limits from Meta's generic-template page (read 2026-11-09):
 * at most 10 elements, `title` at most 80 characters, at most 3 buttons,
 * `postback` and `web_url` buttons only, `image_url` optional.
 */
export const CAROUSEL_MAX_ELEMENTS = 10;
const TITLE_MAX = 80;
const LABEL_MAX = 20;
/** Canonical item ids (`<sourceSystem>:<sourceEntityId>`), bounded. */
export const CAROUSEL_ITEM_ID = /^[A-Za-z0-9._:-]{1,200}$/u;
const PAYLOAD_PREFIX = 'item:';

const ImageUrlSchema = z
  .string()
  .max(2_000)
  .url()
  .refine((value) => value.startsWith('https://'));

export const CarouselSpecSchema = z
  .object({
    kind: z.literal('instagram_carousel'),
    label: z.string().min(1).max(LABEL_MAX),
    items: z
      .array(
        z
          .object({
            id: z.string().regex(CAROUSEL_ITEM_ID),
            title: z.string().min(1).max(TITLE_MAX),
            imageUrl: ImageUrlSchema.optional(),
          })
          .strict(),
      )
      .min(2)
      .max(CAROUSEL_MAX_ELEMENTS),
  })
  .strict();
export type CarouselSpec = z.infer<typeof CarouselSpecSchema>;

/** At most `max` characters (code points); a cut title ends with "…". */
function bounded(text: string, max: number): string {
  const chars = [...text.replace(/\s+/gu, ' ').trim()];
  return chars.length <= max
    ? chars.join('')
    : `${chars.slice(0, max - 1).join('')}…`;
}

/**
 * The carousel for a reply, or null when it showed fewer than two catalog
 * items. Only title facts the reply actually showed (`shownFactIds`, in that
 * order) and that carry a canonical item id are used.
 */
export function buildCarousel(
  facts: readonly Fact[],
  shownFactIds: readonly string[],
  label: string,
): CarouselSpec | null {
  const byId = new Map(facts.map((fact) => [fact.id, fact]));
  const seen = new Set<string>();
  const items: CarouselSpec['items'][number][] = [];
  for (const factId of shownFactIds) {
    const value = byId.get(factId)?.value;
    if (value?.kind !== 'title' || !value.itemId) continue;
    if (!CAROUSEL_ITEM_ID.test(value.itemId) || seen.has(value.itemId))
      continue;
    const title = bounded(value.text, TITLE_MAX);
    if (title === '') continue;
    seen.add(value.itemId);
    const image = ImageUrlSchema.safeParse(value.imageUrl);
    items.push({
      id: value.itemId,
      title,
      ...(image.success ? { imageUrl: image.data } : {}),
    });
    if (items.length === CAROUSEL_MAX_ELEMENTS) break;
  }
  const spec = {
    kind: 'instagram_carousel',
    label: bounded(label, LABEL_MAX),
    items,
  };
  const parsed = CarouselSpecSchema.safeParse(spec);
  return parsed.success ? parsed.data : null;
}

/** A stored carousel, or null when the value is not one. */
export function readCarousel(value: unknown): CarouselSpec | null {
  const parsed = CarouselSpecSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function carouselPayload(itemId: string): string {
  return `${PAYLOAD_PREFIX}${itemId}`;
}

/** The item id in an untrusted postback payload, or null. */
export function parseCarouselPayload(payload: string): string | null {
  if (!payload.startsWith(PAYLOAD_PREFIX)) return null;
  const itemId = payload.slice(PAYLOAD_PREFIX.length);
  return CAROUSEL_ITEM_ID.test(itemId) ? itemId : null;
}

/** The `message` object of the Send API request. */
export function genericTemplateMessage(spec: CarouselSpec): {
  readonly attachment: unknown;
} {
  return {
    attachment: {
      type: 'template',
      payload: {
        template_type: 'generic',
        elements: spec.items.map((item) => ({
          title: item.title,
          ...(item.imageUrl ? { image_url: item.imageUrl } : {}),
          buttons: [
            {
              type: 'postback',
              title: spec.label,
              payload: carouselPayload(item.id),
            },
          ],
        })),
      },
    },
  };
}
