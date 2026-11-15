import { describe, expect, it } from 'vitest';
import en from '@/i18n/en.json';
import { BUILT_IN_CANNED, composerReplies } from './canned';

const t = (key: string): string => (en as Record<string, string>)[key] ?? key;

describe('quick replies in the composer', () => {
  it('offers the five built-in replies, translated, while the workspace has none', () => {
    const items = composerReplies([], t);
    expect(items).toHaveLength(BUILT_IN_CANNED.length);
    for (const item of items) {
      expect(item.text).not.toMatch(/^canned\./u);
      expect(item.title).toBe(item.text);
    }
  });

  it('offers only the workspace’s own replies once it has any', () => {
    const own = [
      { id: 'a', title: 'Prices', text: 'Our prices…', position: 0 },
    ];
    expect(composerReplies(own, t)).toEqual(own);
  });
});
