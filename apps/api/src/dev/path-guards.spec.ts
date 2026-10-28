import { describe, expect, it } from 'vitest';
import { assertOutsideRepository, isInsideDirectory } from './path-guards.js';

const ROOT = '/work/repo';
const CWD = '/work/repo/apps/api';

describe('isInsideDirectory (probe and demo output guard)', () => {
  it.each([
    ['./x', true],
    ['x', true],
    ['../x', true],
    ['../../x', true],
    ['../../../x', false],
    ['/work/repo', true],
    ['/work/repo/', true],
    ['/work/repo/apps/../docs', true],
    ['/work/repo/..x', true],
    ['/work/repo-other/out', false],
    ['/tmp/probe', false],
  ])('%s from apps/api -> inside: %s', (target, inside) => {
    expect(isInsideDirectory(target, ROOT, CWD)).toBe(inside);
  });

  it('refuses inside the repository and returns the resolved path outside', () => {
    expect(() => assertOutsideRepository('./x', ROOT, CWD)).toThrow(
      'outside the repository',
    );
    expect(assertOutsideRepository('../../../x', ROOT, CWD)).toBe('/work/x');
  });
});
