import { describe, expect, it } from 'vitest';
import {
  groupOf,
  SETTINGS_GROUPS,
  visibleSections,
  type SettingsSection,
} from './settings-section-nav';

const ALL: SettingsSection[] = [
  'bot',
  'knowledge',
  'test',
  'channels',
  'crm',
  'pipeline',
  'catalog',
  'fields',
  'team',
  'subscription',
  'security',
  'general',
];

describe('settings groups', () => {
  it('has four groups and puts every section in exactly one of them', () => {
    expect(SETTINGS_GROUPS.map((g) => g.key)).toEqual([
      'assistant',
      'channels',
      'sales',
      'account',
    ]);
    const placed = SETTINGS_GROUPS.flatMap((g) => g.sections.map((s) => s.key));
    expect([...placed].sort()).toEqual([...ALL].sort());
    expect(new Set(placed).size).toBe(placed.length);
  });

  it('groups the assistant, the selling and the account as the UX review asks', () => {
    expect(groupOf('knowledge')).toBe('assistant');
    expect(groupOf('test')).toBe('assistant');
    expect(groupOf('pipeline')).toBe('sales');
    expect(groupOf('crm')).toBe('sales');
    expect(groupOf('fields')).toBe('sales');
    expect(groupOf('team')).toBe('account');
    expect(groupOf('security')).toBe('account');
  });

  it('hides what only owners and admins may open from everybody else', () => {
    const keys = (manager: boolean): string[] =>
      SETTINGS_GROUPS.flatMap((g) =>
        visibleSections(g, manager).map((s) => s.key),
      );
    expect(keys(true).sort()).toEqual([...ALL].sort());
    expect(keys(false).sort()).toEqual(
      ALL.filter(
        (k) => !['test', 'catalog', 'team', 'subscription'].includes(k),
      ).sort(),
    );
  });

  it('gives every section its own address, the old ones unchanged', () => {
    const hrefs = Object.fromEntries(
      SETTINGS_GROUPS.flatMap((g) => g.sections.map((s) => [s.key, s.href])),
    );
    expect(hrefs).toMatchObject({
      bot: '/settings/bot',
      knowledge: '/knowledge',
      test: '/settings/bot/test',
      channels: '/settings/channels',
      pipeline: '/settings/pipeline',
      catalog: '/settings/catalog',
      fields: '/settings/fields',
      crm: '/settings/crm',
      team: '/settings/team',
      subscription: '/settings/subscription',
      security: '/settings/security',
      general: '/settings',
    });
  });
});
