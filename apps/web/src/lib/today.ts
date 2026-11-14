import type { ChannelAccount } from './types';

/** The numbers of `GET /api/v1/today` (counts only). */
export interface TodaySummary {
  waiting: { total: number; overdue: number };
  newLeads: number;
  /** Only for owners and admins. */
  checklist: {
    channelConnected: boolean;
    hasContent: boolean;
    teamInvited: boolean;
    operatorGroup: boolean;
    testedAssistant: boolean;
  } | null;
}

export type AssistantLight = 'live' | 'drafts' | 'hold' | 'off' | 'none';

/**
 * The assistant's state as one traffic light, from what the server really does
 * (`effectiveMode`, not the mode someone asked for). A switched-off account
 * (DISABLED) does not answer whatever its mode says.
 */
export function assistantLight(
  accounts: ReadonlyArray<
    Pick<ChannelAccount, 'status' | 'agentMode' | 'effectiveMode'>
  >,
): AssistantLight {
  if (accounts.length === 0) return 'none';
  const active = accounts.filter((account) => account.status === 'ACTIVE');
  if (active.some((account) => account.effectiveMode === 'LIVE')) return 'live';
  if (active.some((account) => account.effectiveMode === 'SHADOW'))
    return 'drafts';
  if (
    active.some(
      (account) =>
        account.effectiveMode === 'HOLD' && account.agentMode !== 'OFF',
    )
  )
    return 'hold';
  return 'off';
}

export type SetupKey =
  'channel' | 'content' | 'test' | 'assistant' | 'team' | 'group';

export interface SetupItem {
  key: SetupKey;
  done: boolean;
  href: string;
}

/** The getting-started list, in the order a new workspace does it. */
export function setupItems(
  checklist: NonNullable<TodaySummary['checklist']>,
  light: AssistantLight,
): SetupItem[] {
  return [
    {
      key: 'channel',
      done: checklist.channelConnected,
      href: '/settings/channels',
    },
    { key: 'content', done: checklist.hasContent, href: '/settings/catalog' },
    {
      key: 'test',
      done: checklist.testedAssistant,
      href: '/settings/bot/test',
    },
    { key: 'assistant', done: light === 'live', href: '/settings/bot' },
    { key: 'team', done: checklist.teamInvited, href: '/settings/team' },
    { key: 'group', done: checklist.operatorGroup, href: '/settings/channels' },
  ];
}

export function greetingPart(
  hour: number,
): 'morning' | 'afternoon' | 'evening' {
  if (hour >= 5 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 18) return 'afternoon';
  return 'evening';
}

/** The hour (0-23) in a time zone; the browser's own zone when none is given. */
export function hourIn(now: Date, timeZone?: string): number {
  try {
    const hour = new Intl.DateTimeFormat('en-GB', {
      hour: 'numeric',
      hourCycle: 'h23',
      ...(timeZone ? { timeZone } : {}),
    }).format(now);
    return Number(hour) % 24;
  } catch {
    return now.getHours();
  }
}
