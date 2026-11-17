import { describe, expect, it } from 'vitest';
import { inviteUrl } from './invite-link';

describe('inviteUrl', () => {
  it.each([
    ['/invite/abc_DEF-123', 'https://t.example/invite/abc_DEF-123'],
    ['/console/invite/abc', 'https://t.example/console/invite/abc'],
    ['/reset/abc_DEF-123', 'https://t.example/reset/abc_DEF-123'],
  ])('builds a link on this origin for %s', (path, url) => {
    expect(inviteUrl(path, 'https://t.example')).toBe(url);
  });

  it.each([
    ['//evil.example/invite/abc'],
    ['https://evil.example/reset/abc'],
    ['/reset/abc/../../x'],
    ['/login'],
  ])('refuses %s', (path) => {
    expect(inviteUrl(path, 'https://t.example')).toBeUndefined();
  });
});
