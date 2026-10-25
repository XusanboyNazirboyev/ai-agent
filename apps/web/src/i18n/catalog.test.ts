import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CATALOGS, LOCALES, detectLocale, translate } from './index';

const argNames = (message: string): string[] =>
  [...message.matchAll(/\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*[,}]/gu)]
    .map((match) => match[1])
    .sort();

describe('translation catalogs (CI gate)', () => {
  const reference = Object.keys(CATALOGS.en).sort();

  it.each(LOCALES)(
    '%s has exactly the keys of the English catalog',
    (locale) => {
      const keys = Object.keys(CATALOGS[locale]).sort();
      expect(keys.filter((key) => !reference.includes(key))).toEqual([]);
      expect(reference.filter((key) => !keys.includes(key))).toEqual([]);
    },
  );

  it.each(LOCALES)(
    '%s has no empty values and the same ICU arguments',
    (locale) => {
      for (const key of reference) {
        const value = CATALOGS[locale][key];
        expect(value?.trim(), `${locale}:${key}`).toBeTruthy();
        expect(argNames(value), `${locale}:${key}`).toEqual(
          argNames(CATALOGS.en[key]),
        );
      }
    },
  );

  it('formats plurals per language', () => {
    expect(translate('en', 'list.waitingFor', { minutes: 1 })).toContain(
      '1 minute',
    );
    expect(translate('en', 'list.waitingFor', { minutes: 5 })).toContain(
      '5 minutes',
    );
    expect(translate('ru', 'list.waitingFor', { minutes: 1 })).toContain(
      '1 минуту',
    );
    expect(translate('ru', 'list.waitingFor', { minutes: 3 })).toContain(
      '3 минуты',
    );
    expect(translate('ru', 'list.waitingFor', { minutes: 5 })).toContain(
      '5 минут',
    );
  });

  it('returns the key for unknown messages instead of throwing', () => {
    expect(translate('ru', 'does.not.exist')).toBe('does.not.exist');
  });

  it('detects the locale from storage or browser languages', () => {
    expect(detectLocale('ru', ['en-US'])).toBe('ru');
    expect(detectLocale(null, ['uz-UZ'])).toBe('uz-Latn');
    expect(detectLocale('xx', ['ru-RU'])).toBe('ru');
    expect(detectLocale(null, ['de'])).toBe('en');
  });
});

/** Literal text between JSX tags (expressions in braces are ignored). */
export function findHardcodedText(source: string): string[] {
  let stripped = source;
  for (let i = 0; i < 20 && /\{[^{}]*\}/u.test(stripped); i += 1)
    stripped = stripped.replace(/\{[^{}]*\}/gu, '');
  const found: string[] = [];
  for (const match of stripped.matchAll(
    /<[A-Za-z][\w.]*(?:\s[^<>]*)?>([^<>]*[A-Za-z\u0400-\u04FF][^<>]*)</gu,
  )) {
    const text = match[1].trim();
    if (text) found.push(text);
  }
  return found;
}

describe('hardcoded text detector', () => {
  it('flags literal text and accepts expressions', () => {
    expect(findHardcodedText('<p className="a">Hello there</p>')).toEqual([
      'Hello there',
    ]);
    expect(
      findHardcodedText('<button onClick={() => go()}>Привет</button>'),
    ).toEqual(['Привет']);
    expect(findHardcodedText("<p>{t('a.b')}</p>")).toEqual([]);
    expect(findHardcodedText('<p>{count} / {total}</p>')).toEqual([]);
  });
});

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/u.test(entry) && !/\.test\./u.test(entry) ? [path] : [];
  });
}

describe('source uses the catalog', () => {
  const root = resolve(import.meta.dirname, '..');
  const files = sourceFiles(root);

  it('every statically used translation key exists', () => {
    const missing: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(/\bt\(\s*'([A-Za-z0-9_.-]+)'/gu))
        if (!(match[1] in CATALOGS.en)) missing.push(`${file}:${match[1]}`);
    }
    expect(missing).toEqual([]);
  });

  it('every dynamic key family has all its members', () => {
    const families: Record<string, string[]> = {
      state: ['BOT_ACTIVE', 'WAITING_OPERATOR', 'OPERATOR_ACTIVE', 'CLOSED'],
      author: ['CUSTOMER', 'BOT', 'OPERATOR', 'SYSTEM'],
      delivery: ['PENDING', 'SENT', 'FAILED', 'UNKNOWN'],
      score: ['HOT', 'WARM', 'COLD'],
      leadStatus: ['NEW', 'IN_PROGRESS', 'WON', 'LOST'],
      role: ['OWNER', 'ADMIN', 'OPERATOR', 'VIEWER'],
      scope: ['waiting', 'mine', 'all', 'closed'],
      canned: ['greeting', 'wait', 'details', 'thanks', 'bye'],
      connection: ['live', 'connecting', 'reconnecting', 'polling'],
      actionStatus: [
        'PROPOSED',
        'CONFIRMED',
        'DECLINED',
        'SUPERSEDED',
        'EXPIRED',
        'CANCELLED',
        'SUCCEEDED',
        'FAILED',
        'UNCERTAIN',
      ],
      locale: ['en', 'ru', 'uz-Latn'],
      importProblem: [
        'EMPTY_FILE',
        'TOO_BIG',
        'BAD_FORMAT',
        'MISSING_COLUMNS',
        'MISSING_TEXT',
        'QUESTION_TOO_SHORT',
        'QUESTION_TOO_LONG',
        'ANSWER_TOO_LONG',
        'TOO_MANY',
      ],
      nav: [
        'inbox',
        'leads',
        'contacts',
        'bot',
        'knowledge',
        'channels',
        'settings',
        'more',
      ],
      'more.desc': ['bot', 'knowledge', 'channels', 'settings'],
      botMode: ['OFF', 'SHADOW', 'LIVE'],
      botModeDesc: ['OFF', 'SHADOW', 'LIVE'],
      botRefusal: [
        'UNTRUSTED_PROVIDER',
        'NO_OPERATOR_NOTIFIER',
        'UNTRUSTED_REAL_DATA',
      ],
      channelStatus: ['ACTIVE', 'DISABLED'],
      agentMode: ['OFF', 'SHADOW', 'LIVE'],
      'channels.desc': ['telegram', 'instagram', 'whatsapp', 'webchat'],
      theme: ['system', 'light', 'dark'],
      permission: ['granted', 'denied', 'default', 'unsupported'],
    };
    for (const [family, ids] of Object.entries(families))
      for (const id of ids)
        expect(CATALOGS.en, `${family}.${id}`).toHaveProperty(
          `${family}.${id}`,
        );
  });

  it('every API error code the client can show has a message', () => {
    for (const code of [
      'UNAUTHENTICATED',
      'INVALID_CREDENTIALS',
      'LOCKED',
      'RATE_LIMITED',
      'ALREADY_TAKEN',
      'NOT_ASSIGNED',
      'ILLEGAL_STATE',
      'FORBIDDEN',
      'NOT_FOUND',
      'NO_LEAD',
      'MISSING_EVIDENCE',
      'NOT_UNCERTAIN',
      'INVALID_BODY',
      'CSRF',
      'BAD_ORIGIN',
      'NETWORK',
      'MODE_REFUSED',
      'KNOWLEDGE_DISABLED',
      'EMBEDDING_FAILED',
      'FAQ_LIMIT',
      'UNKNOWN',
    ])
      expect(CATALOGS.en, code).toHaveProperty(`errors.${code}`);
  });

  it('has no hardcoded user-facing text in JSX', () => {
    const offenders: string[] = [];
    for (const file of files.filter((f) => f.endsWith('.tsx'))) {
      if (file.endsWith('layout.tsx')) continue;
      const source = readFileSync(file, 'utf8');
      offenders.push(
        ...findHardcodedText(source).map((text) => `${file}: ${text}`),
      );
      // Literal accessibility / placeholder attributes.
      for (const match of source.matchAll(
        /\b(aria-label|placeholder|title|alt)="([^"]+)"/gu,
      ))
        offenders.push(`${file}: ${match[1]}="${match[2]}"`);
    }
    expect(offenders).toEqual([]);
  });
});
