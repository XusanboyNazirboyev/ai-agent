import { describe, expect, it } from 'vitest';
import {
  proposeStage,
  type StageRef,
  type StageSignals,
} from './propose-stage.js';

const stage = (
  code: string | null,
  position: number,
  kind: StageRef['kind'] = 'OPEN',
): StageRef => ({ id: `id-${code ?? position}`, code, position, kind });

const FUNNEL: StageRef[] = [
  stage('NEW', 0),
  stage('CONTACTED', 1),
  stage('QUALIFIED', 2),
  stage('PROPOSAL', 3),
  stage('NEGOTIATION', 4),
  stage('WON', 5, 'WON'),
  stage('LOST', 6, 'LOST'),
];
const NONE: StageSignals = {
  created: false,
  customerMessageCount: 0,
  agentAskedQuestion: false,
  requiredSlotsFilled: false,
  hasPhone: false,
  offerShown: false,
  quoteShown: false,
  openHandover: false,
};
const at = (code: string): StageRef => FUNNEL.find((s) => s.code === code)!;

describe('proposeStage transitions', () => {
  it.each([
    [{ customerMessageCount: 2 }, 'NEW', 'CONTACTED', ['customer_replied']],
    [
      { agentAskedQuestion: true },
      'NEW',
      'CONTACTED',
      ['agent_asked_question'],
    ],
    [
      { requiredSlotsFilled: true, hasPhone: true },
      'CONTACTED',
      'QUALIFIED',
      ['requirements_filled', 'phone_collected'],
    ],
    [{ offerShown: true }, 'QUALIFIED', 'PROPOSAL', ['offer_shown']],
    [{ quoteShown: true }, 'NEW', 'PROPOSAL', ['quote_shown']],
    [{ openHandover: true }, 'PROPOSAL', 'NEGOTIATION', ['handover_open']],
  ] as const)('%j from %s proposes %s', (partial, from, to, reasons) => {
    expect(proposeStage({ ...NONE, ...partial }, FUNNEL, at(from))).toEqual({
      code: to,
      reasonCodes: reasons,
    });
  });

  it('proposes NEW for a created lead that has no stage yet', () => {
    expect(proposeStage({ ...NONE, created: true }, FUNNEL, null)).toEqual({
      code: 'NEW',
      reasonCodes: ['lead_created'],
    });
  });

  it('needs both the slots and a phone for QUALIFIED', () => {
    expect(
      proposeStage({ ...NONE, requiredSlotsFilled: true }, FUNNEL, at('NEW')),
    ).toBeNull();
    expect(
      proposeStage({ ...NONE, hasPhone: true }, FUNNEL, at('NEW')),
    ).toBeNull();
  });

  it('does not count one customer message alone as contact', () => {
    expect(
      proposeStage({ ...NONE, customerMessageCount: 1 }, FUNNEL, at('NEW')),
    ).toBeNull();
  });

  it('takes the furthest matching stage', () => {
    expect(
      proposeStage(
        {
          ...NONE,
          customerMessageCount: 5,
          offerShown: true,
          openHandover: true,
        },
        FUNNEL,
        at('NEW'),
      )?.code,
    ).toBe('NEGOTIATION');
  });
});

describe('proposeStage guarantees', () => {
  it('never moves backwards or sideways', () => {
    expect(
      proposeStage(
        { ...NONE, customerMessageCount: 3 },
        FUNNEL,
        at('QUALIFIED'),
      ),
    ).toBeNull();
    expect(
      proposeStage(
        { ...NONE, customerMessageCount: 3 },
        FUNNEL,
        at('CONTACTED'),
      ),
    ).toBeNull();
    expect(
      proposeStage({ ...NONE, offerShown: true }, FUNNEL, at('NEGOTIATION')),
    ).toBeNull();
  });

  it('never proposes or leaves a WON or LOST stage', () => {
    const everything: StageSignals = {
      created: true,
      customerMessageCount: 9,
      agentAskedQuestion: true,
      requiredSlotsFilled: true,
      hasPhone: true,
      offerShown: true,
      quoteShown: true,
      openHandover: true,
    };
    expect(proposeStage(everything, FUNNEL, at('WON'))).toBeNull();
    expect(proposeStage(everything, FUNNEL, at('LOST'))).toBeNull();
    const onlyClosed = [stage('WON', 0, 'WON'), stage('LOST', 1, 'LOST')];
    expect(proposeStage(everything, onlyClosed, null)).toBeNull();
    // A coded stage that is closed is not a target even when its code matches.
    const odd = [stage('NEW', 0), stage('PROPOSAL', 1, 'WON')];
    expect(
      proposeStage({ ...NONE, offerShown: true }, odd, at('NEW')),
    ).toBeNull();
  });

  it('a lead in a closed stage that sorts before the open ones is still left alone', () => {
    const odd = [
      stage('WON', 0, 'WON'),
      stage('NEW', 1),
      stage('CONTACTED', 2),
    ];
    expect(
      proposeStage({ ...NONE, customerMessageCount: 3 }, odd, odd[0]!),
    ).toBeNull();
    expect(
      proposeStage({ ...NONE, customerMessageCount: 3 }, odd, odd[1]!)?.code,
    ).toBe('CONTACTED');
  });

  it('only uses stage codes that exist in the pipeline', () => {
    const small = [
      stage('NEW', 0),
      stage('QUALIFIED', 1),
      stage('WON', 2, 'WON'),
    ];
    expect(
      proposeStage({ ...NONE, offerShown: true }, small, small[0]!),
    ).toBeNull();
    expect(
      proposeStage(
        { ...NONE, requiredSlotsFilled: true, hasPhone: true },
        small,
        small[0]!,
      )?.code,
    ).toBe('QUALIFIED');
    // Custom (uncoded) stages and the legacy NEW/HOT/WARM/COLD get no moves.
    const legacy = [
      stage('NEW', 0),
      stage('HOT', 1),
      stage('WARM', 2),
      stage(null, 3),
    ];
    expect(
      proposeStage(
        { ...NONE, customerMessageCount: 4, offerShown: true },
        legacy,
        legacy[0]!,
      ),
    ).toBeNull();
  });

  it('follows position order, not array order', () => {
    const shuffled = [at('QUALIFIED'), at('NEW'), at('CONTACTED')];
    expect(
      proposeStage(
        { ...NONE, customerMessageCount: 2 },
        shuffled,
        at('QUALIFIED'),
      ),
    ).toBeNull();
    expect(
      proposeStage({ ...NONE, customerMessageCount: 2 }, shuffled, at('NEW'))
        ?.code,
    ).toBe('CONTACTED');
  });

  it('proposes nothing without signals', () => {
    expect(proposeStage(NONE, FUNNEL, at('NEW'))).toBeNull();
  });
});
