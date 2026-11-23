import { describe, expect, it } from 'vitest';
import {
  groupOf,
  SETTINGS_GROUPS,
  visibleSections,
  type SettingsSection,
} from './settings-section-nav';
import { AGENT_SECTIONS, visibleAgentSections } from './agent-section-nav';

const ALL: SettingsSection[] = [
  'channels',
  'replies',
  'crm',
  'pipeline',
  'fields',
  'team',
  'subscription',
  'security',
  'history',
  'general',
];

describe('settings groups', () => {
  // Owner 2026-11-23: the assistant group moved to its own AI agent section.
  it('has three groups and puts every section in exactly one of them', () => {
    expect(SETTINGS_GROUPS.map((g) => g.key)).toEqual([
      'channels',
      'sales',
      'account',
    ]);
    const placed = SETTINGS_GROUPS.flatMap((g) => g.sections.map((s) => s.key));
    expect([...placed].sort()).toEqual([...ALL].sort());
    expect(new Set(placed).size).toBe(placed.length);
  });

  it('groups the selling and the account as the UX review asks', () => {
    expect(groupOf('pipeline')).toBe('sales');
    expect(groupOf('crm')).toBe('sales');
    expect(groupOf('fields')).toBe('sales');
    expect(groupOf('replies')).toBe('channels');
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
        (k) => !['team', 'subscription', 'history'].includes(k),
      ).sort(),
    );
  });

  it('gives every section its own address, the old ones unchanged', () => {
    const hrefs = Object.fromEntries(
      SETTINGS_GROUPS.flatMap((g) => g.sections.map((s) => [s.key, s.href])),
    );
    expect(hrefs).toMatchObject({
      channels: '/settings/channels',
      replies: '/settings/replies',
      pipeline: '/settings/pipeline',
      fields: '/settings/fields',
      crm: '/settings/crm',
      team: '/settings/team',
      subscription: '/settings/subscription',
      security: '/settings/security',
      history: '/settings/history',
      general: '/settings',
    });
  });
});

describe('AI agent section (owner 2026-11-23)', () => {
  it('lists overview, knowledge, rules, prices and test; prices and test for managers only', () => {
    expect(AGENT_SECTIONS.map((s) => [s.key, s.href])).toEqual([
      ['dashboard', '/agent'],
      ['knowledge', '/agent/knowledge'],
      ['rules', '/agent/rules'],
      ['prices', '/agent/prices'],
      ['test', '/agent/test'],
    ]);
    expect(visibleAgentSections(false).map((s) => s.key)).toEqual([
      'dashboard',
      'knowledge',
      'rules',
    ]);
    expect(visibleAgentSections(true)).toHaveLength(5);
  });
});
