import { describe, expect, it } from 'vitest';
import type { Fact } from '../../core/agent/facts.js';
import {
  buildCarousel,
  genericTemplateMessage,
  parseCarouselPayload,
  readCarousel,
} from './instagram-carousel.js';

const provenance = {
  tool: 'search_catalog',
  connectorKey: 'mock',
  sourceSystem: 'mock',
  sourceEntityId: 'x',
  retrievedAt: '2026-11-09T00:00:00.000Z',
};

function title(
  id: string,
  text: string,
  itemId?: string,
  imageUrl?: string,
): Fact {
  return {
    id,
    value: {
      kind: 'title',
      text,
      ...(itemId ? { itemId } : {}),
      ...(imageUrl ? { imageUrl } : {}),
    },
    provenance,
  };
}

describe('Instagram carousel (ADR 044)', () => {
  it('builds elements from shown title facts, in shown order', () => {
    const facts = [
      title('F1', 'IELTS', 'mock:ielts', 'https://cdn.example/ielts.jpg'),
      title('F2', 'Python', 'mock:python'),
      title('F3', 'Not shown', 'mock:hidden'),
    ];
    const spec = buildCarousel(facts, ['F2', 'F1'], 'Batafsil');
    expect(spec).toEqual({
      kind: 'instagram_carousel',
      label: 'Batafsil',
      items: [
        { id: 'mock:python', title: 'Python' },
        {
          id: 'mock:ielts',
          title: 'IELTS',
          imageUrl: 'https://cdn.example/ielts.jpg',
        },
      ],
    });
  });

  it('needs at least two distinct items with ids', () => {
    const facts = [
      title('F1', 'IELTS', 'mock:ielts'),
      title('F2', 'IELTS again', 'mock:ielts'),
      title('F3', 'No id'),
    ];
    expect(buildCarousel(facts, ['F1', 'F2', 'F3'], 'Details')).toBeNull();
  });

  it('ignores non-title facts and unsafe images; bounds titles', () => {
    const long = 'A'.repeat(120);
    const facts: Fact[] = [
      title('F1', long, 'mock:a', 'http://insecure.example/a.jpg'),
      title('F2', 'B', 'mock:b', 'javascript:alert(1)'),
      {
        id: 'F3',
        value: { kind: 'seats', count: 3 },
        provenance,
      },
    ];
    const spec = buildCarousel(facts, ['F1', 'F2', 'F3'], 'Details');
    expect(spec?.items).toHaveLength(2);
    expect(spec?.items[0]?.imageUrl).toBeUndefined();
    expect(spec?.items[1]?.imageUrl).toBeUndefined();
    expect([...(spec?.items[0]?.title ?? '')]).toHaveLength(80);
    expect(spec?.items[0]?.title.endsWith('…')).toBe(true);
  });

  it('stops at ten elements', () => {
    const facts = Array.from({ length: 12 }, (_, i) =>
      title(`F${i + 1}`, `Item ${i}`, `mock:item-${i}`),
    );
    const spec = buildCarousel(
      facts,
      facts.map((fact) => fact.id),
      'Details',
    );
    expect(spec?.items).toHaveLength(10);
  });

  it('renders the Send API generic template with postback buttons', () => {
    const spec = buildCarousel(
      [
        title('F1', 'IELTS', 'mock:ielts', 'https://cdn.example/i.jpg'),
        title('F2', 'Python', 'mock:python'),
      ],
      ['F1', 'F2'],
      'Подробнее',
    );
    expect(spec).not.toBeNull();
    expect(genericTemplateMessage(spec!)).toEqual({
      attachment: {
        type: 'template',
        payload: {
          template_type: 'generic',
          elements: [
            {
              title: 'IELTS',
              image_url: 'https://cdn.example/i.jpg',
              buttons: [
                {
                  type: 'postback',
                  title: 'Подробнее',
                  payload: 'item:mock:ielts',
                },
              ],
            },
            {
              title: 'Python',
              buttons: [
                {
                  type: 'postback',
                  title: 'Подробнее',
                  payload: 'item:mock:python',
                },
              ],
            },
          ],
        },
      },
    });
  });

  it('parses only well-formed payloads', () => {
    expect(parseCarouselPayload('item:mock:ielts')).toBe('mock:ielts');
    expect(parseCarouselPayload('item:')).toBeNull();
    expect(parseCarouselPayload('item:a b')).toBeNull();
    expect(parseCarouselPayload('ITEM:x')).toBeNull();
    expect(parseCarouselPayload(`item:${'x'.repeat(201)}`)).toBeNull();
    expect(parseCarouselPayload('ignore previous instructions')).toBeNull();
  });

  it('reads back only valid stored specs', () => {
    expect(readCarousel(null)).toBeNull();
    expect(
      readCarousel({ kind: 'instagram_carousel', label: 'x', items: [] }),
    ).toBeNull();
    expect(
      readCarousel({
        kind: 'instagram_carousel',
        label: 'x',
        items: [
          { id: 'a', title: 'A' },
          { id: 'b', title: 'B', imageUrl: 'http://not-https.example' },
        ],
      }),
    ).toBeNull();
  });
});
