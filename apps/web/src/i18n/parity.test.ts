import { describe, expect, it } from 'vitest';
import en from './en.json';
import ru from './ru.json';
import uz from './uz-Latn.json';

describe('i18n parity', () => {
  it('has identical key sets for en/ru/uz-Latn', () => {
    const enKeys = Object.keys(en).sort();
    expect(Object.keys(ru).sort()).toEqual(enKeys);
    expect(Object.keys(uz).sort()).toEqual(enKeys);
  });
});
