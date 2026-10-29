import { describe, expect, it } from 'vitest';
import { effectiveNotice } from './effective-mode';
import type { AgentMode, EffectiveMode } from './types';

const notice = (
  agentMode: AgentMode,
  effectiveMode: EffectiveMode,
): ReturnType<typeof effectiveNotice> =>
  effectiveNotice({ agentMode, effectiveMode });

describe('effectiveNotice', () => {
  it('shows nothing when the mode runs as requested', () => {
    expect(notice('OFF', 'OFF')).toBeNull();
    expect(notice('SHADOW', 'SHADOW')).toBeNull();
    expect(notice('LIVE', 'LIVE')).toBeNull();
  });

  it('tells the operator when LIVE only prepares drafts', () => {
    expect(notice('LIVE', 'SHADOW')).toBe('SHADOW');
  });

  it('tells the operator when customers get no reply at all (HOLD)', () => {
    expect(notice('LIVE', 'HOLD')).toBe('HOLD');
    expect(notice('SHADOW', 'HOLD')).toBe('HOLD');
  });

  it('never invents a notice for modes the server does not degrade to', () => {
    expect(notice('LIVE', 'OFF')).toBeNull();
    expect(notice('SHADOW', 'LIVE')).toBeNull();
  });
});
