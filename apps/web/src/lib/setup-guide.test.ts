import { describe, expect, it } from 'vitest';
import {
  EMPTY_GUIDE_LOCAL,
  currentStep,
  guideSteps,
  guideVisible,
  parseGuideLocal,
} from './setup-guide';

const none = {
  channelConnected: false,
  hasContent: false,
  teamInvited: false,
  operatorGroup: false,
  testedAssistant: false,
};

describe('setup guide', () => {
  it('takes done states from the Today checklist', () => {
    const steps = guideSteps(
      { ...none, channelConnected: true, hasContent: true },
      'off',
      EMPTY_GUIDE_LOCAL,
    );
    expect(steps.map((s) => [s.key, s.done])).toEqual([
      ['business', false],
      ['channel', true],
      ['content', true],
      ['test', false],
      ['assistant', false],
    ]);
    expect(guideSteps(none, 'live', EMPTY_GUIDE_LOCAL).at(-1)?.done).toBe(true);
  });
  it('shows the first step that is neither done nor skipped', () => {
    const local = { ...EMPTY_GUIDE_LOCAL, skipped: ['business' as const] };
    expect(currentStep(guideSteps(none, 'none', local))?.key).toBe('channel');
    expect(
      currentStep(guideSteps(none, 'none', { ...local, businessDone: true }))
        ?.key,
    ).toBe('channel');
  });
  it('shows only for a new workspace until finished or put away', () => {
    const steps = guideSteps(none, 'none', EMPTY_GUIDE_LOCAL);
    const base = {
      welcome: false,
      selfSignup: false,
      steps,
      local: EMPTY_GUIDE_LOCAL,
    };
    expect(guideVisible(base)).toBe(false);
    expect(guideVisible({ ...base, welcome: true })).toBe(true);
    expect(guideVisible({ ...base, selfSignup: true })).toBe(true);
    expect(
      guideVisible({
        ...base,
        selfSignup: true,
        local: { ...EMPTY_GUIDE_LOCAL, dismissed: true },
      }),
    ).toBe(false);
    const finished = guideSteps(
      {
        ...none,
        channelConnected: true,
        hasContent: true,
        testedAssistant: true,
      },
      'live',
      { ...EMPTY_GUIDE_LOCAL, businessDone: true },
    );
    expect(guideVisible({ ...base, selfSignup: true, steps: finished })).toBe(
      false,
    );
  });
  it('survives bad stored data', () => {
    expect(parseGuideLocal('{nope')).toEqual(EMPTY_GUIDE_LOCAL);
    expect(
      parseGuideLocal(JSON.stringify({ skipped: ['x', 'test'] })).skipped,
    ).toEqual(['test']);
  });
});
