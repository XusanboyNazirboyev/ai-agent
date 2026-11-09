import { describe, expect, it } from 'vitest';
import {
  languageOfReference,
  matchToReferences,
  scriptFoldedErrors,
  normalizeForWer,
  parseWerScript,
  summarizeWer,
  wordErrors,
} from './wer.js';

describe('normalizeForWer', () => {
  it('folds case, punctuation and every apostrophe variant to one form', () => {
    const variants = ['to‘lasa', 'to’lasa', "to'lasa", 'to`lasa', 'toʻlasa'];
    const forms = new Set(variants.map((v) => normalizeForWer(v).join(' ')));
    expect(forms.size).toBe(1);
    expect(normalizeForWer('Kurs narxi qancha turadi, oyiga TO‘LASA?')).toEqual(
      ['kurs', 'narxi', 'qancha', 'turadi', 'oyiga', 'toʻlasa'],
    );
  });

  it('keeps digits as words and drops stray quote marks', () => {
    expect(normalizeForWer('“Soat 3:00 da” — ‘ha’')).toEqual([
      'soat',
      '3',
      '00',
      'da',
      'ha',
    ]);
  });
});

describe('wordErrors', () => {
  it('counts substitutions, deletions and insertions', () => {
    expect(wordErrors('ertaga soat uchga', 'ertaga soat uchga')).toEqual({
      referenceWords: 3,
      substitutions: 0,
      deletions: 0,
      insertions: 0,
    });
    expect(wordErrors('ertaga soat uchga', 'ertaqiy saat uchga')).toMatchObject(
      { substitutions: 2, deletions: 0, insertions: 0 },
    );
    expect(wordErrors('shanba kuni', 'sanbakhuni')).toMatchObject({
      substitutions: 1,
      deletions: 1,
      insertions: 0,
    });
    expect(wordErrors('ha', 'ha ha ha')).toMatchObject({ insertions: 2 });
  });
});

describe('summarizeWer', () => {
  it('weights by reference words, not by line', () => {
    const summary = summarizeWer([
      wordErrors('bir ikki uch tort', 'bir ikki uch tort'),
      wordErrors('besh', 'olti'),
    ]);
    expect(summary.wer).toBeCloseTo(1 / 5);
    expect(summary.referenceWords).toBe(5);
  });
});

describe('parseWerScript', () => {
  it('reads numbered lines and strips the (noise) marker', () => {
    const md = [
      '| #   | Line | What it tests |',
      '| --- | ---- | ------------- |',
      '| 01  | Assalomu alaykum, ertaga. | greeting |',
      '| 15  | Ertaga soat uchga. (noise) | noise |',
    ].join('\n');
    expect(parseWerScript(md)).toEqual([
      { id: '01', text: 'Assalomu alaykum, ertaga.', noisy: false },
      { id: '15', text: 'Ertaga soat uchga.', noisy: true },
    ]);
  });
});

describe('matchToReferences', () => {
  const refs = [
    { id: '01', text: 'ertaga soat uchga yozilmoqchiman', noisy: false },
    { id: '02', text: 'kurs narxi qancha turadi', noisy: false },
    { id: '15', text: 'ertaga soat uchga yozilmoqchiman', noisy: true },
  ];

  it('assigns each recording to its closest unused reference', () => {
    const result = matchToReferences(
      ['kurs narxi qancha', 'ertaga soat uchga yozilmoqchiman'],
      refs,
    );
    expect(result.map((m) => m.referenceId)).toEqual(['02', '01']);
  });

  it('never assigns one reference twice', () => {
    const result = matchToReferences(
      ['ertaga soat uchga yozilmoqchiman', 'ertaga soat uchga yozilmoqchiman'],
      refs,
    );
    expect(new Set(result.map((m) => m.referenceId)).size).toBe(2);
  });
});

describe('languageOfReference', () => {
  it('tells Uzbek Latin, Uzbek Cyrillic and Russian apart', () => {
    expect(languageOfReference('Ingliz tili kursining narxi qancha?')).toBe(
      'uz-Latn',
    );
    expect(languageOfReference('Ассалому алайкум, курслар қаерда?')).toBe(
      'uz-Cyrl',
    );
    expect(languageOfReference('Можно записаться на пробный урок?')).toBe('ru');
  });
});

describe('scriptFoldedErrors', () => {
  it('scores Uzbek words regardless of the script they came back in', () => {
    expect(
      scriptFoldedErrors(
        'Assalomu alaykum, IELTS kursi bormi?',
        'Ассалому алайкум, IELTS курси борми?',
      ),
    ).toMatchObject({ substitutions: 0, deletions: 0, insertions: 0 });
    // Exact scoring still counts the script mismatch as wrong words.
    expect(
      wordErrors(
        'Assalomu alaykum, kursi bormi?',
        'Ассалому алайкум, курси борми?',
      ).substitutions,
    ).toBe(4);
  });
});
