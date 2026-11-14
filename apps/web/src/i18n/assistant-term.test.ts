import { describe, expect, it } from 'vitest';
import en from './en.json';
import ru from './ru.json';
import uz from './uz-Latn.json';

// docs/design/glossary.md: the AI that answers customers is "the assistant"
// (Ассистент, Yordamchi), never "the bot". Telegram's own bot (its token, its
// username, the bot that must be switched on) keeps its word, so only the keys
// that name the assistant are listed here: each was found by the 2026-11-14
// audit with the old wording.
const ASSISTANT_KEYS = [
  'state.BOT_ACTIVE',
  'confirm.returnTitle',
  'confirm.returnBody',
  'analytics.tile.autoResolved',
  'handover.reason.GUARDRAIL',
  'handover.reason.TOOL_LOOP_LIMIT',
  'handover.intent.ai_question',
  'handover.group.inferences',
] as const;

const catalogs: Array<[string, Record<string, string>, RegExp]> = [
  ['en', en as Record<string, string>, /\bbot\b/iu],
  ['ru', ru as Record<string, string>, /бот/iu],
  ['uz-Latn', uz as Record<string, string>, /\bbot\b|assistent/iu],
];

describe('the assistant has one name in every language', () => {
  for (const [name, catalog, avoided] of catalogs)
    it(`${name}: the keys that name the assistant do not call it a bot`, () => {
      expect(
        ASSISTANT_KEYS.filter((key) => avoided.test(catalog[key] ?? '')),
      ).toEqual([]);
    });

  it('uz-Latn never spells the assistant "assistent"', () => {
    expect(
      Object.entries(uz as Record<string, string>)
        .filter(([, value]) => /assistent/iu.test(value))
        .map(([key]) => key),
    ).toEqual([]);
  });

  it('the verified-information intent follows the glossary in all languages', () => {
    expect(
      (en as Record<string, string>)['handover.intent.regulated_info'],
    ).not.toMatch(/regulated/iu);
    expect(
      (ru as Record<string, string>)['handover.intent.regulated_info'],
    ).not.toMatch(/регулируем/iu);
  });
});
