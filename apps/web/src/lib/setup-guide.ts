import type { AssistantLight, TodaySummary } from './today';

/** The guided setup of a new owner (ADR 080): one step per card. */
export type GuideKey =
  'business' | 'channel' | 'content' | 'test' | 'assistant';

export interface GuideStep {
  key: GuideKey;
  done: boolean;
  skipped: boolean;
  href: string;
}

export interface GuideLocal {
  /** Steps the person skipped on this device. */
  skipped: GuideKey[];
  /** Step 1 has no server state: the person opened the templates. */
  businessDone: boolean;
  dismissed: boolean;
}

export const EMPTY_GUIDE_LOCAL: GuideLocal = {
  skipped: [],
  businessDone: false,
  dismissed: false,
};

const KEYS: readonly GuideKey[] = [
  'business',
  'channel',
  'content',
  'test',
  'assistant',
];

/** Done states come from `GET /api/v1/today`; nothing is computed twice. */
export function guideSteps(
  checklist: NonNullable<TodaySummary['checklist']>,
  light: AssistantLight,
  local: GuideLocal,
): GuideStep[] {
  const done: Record<GuideKey, boolean> = {
    business: local.businessDone,
    channel: checklist.channelConnected,
    content: checklist.hasContent,
    test: checklist.testedAssistant,
    assistant: light === 'live',
  };
  const href: Record<GuideKey, string> = {
    business: '/settings/crm',
    channel: '/channels/telegram',
    content: '/agent/prices',
    test: '/agent/test',
    assistant: '/agent',
  };
  return KEYS.map((key) => ({
    key,
    done: done[key],
    skipped: local.skipped.includes(key),
    href: href[key],
  }));
}

/** The step to show now: first one neither done nor skipped. */
export function currentStep(
  steps: readonly GuideStep[],
): GuideStep | undefined {
  return steps.find((step) => !step.done && !step.skipped);
}

/**
 * The guide shows for a workspace made by the public signup, or when the
 * signup page just sent the person here (`?welcome=1`), until it is finished
 * or put away.
 */
export function guideVisible(input: {
  welcome: boolean;
  selfSignup: boolean;
  steps: readonly GuideStep[];
  local: GuideLocal;
}): boolean {
  if (input.local.dismissed) return false;
  if (!input.welcome && !input.selfSignup) return false;
  return input.steps.some((step) => !step.done);
}

export function parseGuideLocal(raw: string | null): GuideLocal {
  if (!raw) return EMPTY_GUIDE_LOCAL;
  try {
    const value = JSON.parse(raw) as Partial<GuideLocal>;
    return {
      skipped: Array.isArray(value.skipped)
        ? value.skipped.filter((key): key is GuideKey =>
            KEYS.includes(key as GuideKey),
          )
        : [],
      businessDone: value.businessDone === true,
      dismissed: value.dismissed === true,
    };
  } catch {
    return EMPTY_GUIDE_LOCAL;
  }
}
