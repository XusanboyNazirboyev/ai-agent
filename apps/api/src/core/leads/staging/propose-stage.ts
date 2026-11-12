/**
 * Rule table for the agent's funnel staging (ADR 058 decisions 3-6). Pure and
 * locale-neutral: it sees booleans and counts about the conversation and the
 * pipeline's stages, never customer text and never money. A model does not
 * decide; every proposal carries reason codes.
 */
export interface StageSignals {
  /** The lead was just created by this pass. */
  readonly created: boolean;
  readonly customerMessageCount: number;
  readonly agentAskedQuestion: boolean;
  readonly requiredSlotsFilled: boolean;
  readonly hasPhone: boolean;
  readonly offerShown: boolean;
  readonly quoteShown: boolean;
  readonly openHandover: boolean;
}

export interface StageRef {
  readonly id: string;
  readonly code: string | null;
  readonly position: number;
  readonly kind: 'OPEN' | 'WON' | 'LOST';
}

export interface StageProposal {
  readonly code: string;
  readonly reasonCodes: readonly string[];
}

interface Rule {
  readonly code: string;
  readonly reasons: (signals: StageSignals) => readonly string[];
}

/** Ordered from the furthest stage to the first; the first match that exists wins. */
const RULES: readonly Rule[] = [
  {
    code: 'NEGOTIATION',
    reasons: (s) => (s.openHandover ? ['handover_open'] : []),
  },
  {
    code: 'PROPOSAL',
    reasons: (s) => [
      ...(s.offerShown ? ['offer_shown'] : []),
      ...(s.quoteShown ? ['quote_shown'] : []),
    ],
  },
  {
    code: 'QUALIFIED',
    reasons: (s) =>
      s.requiredSlotsFilled && s.hasPhone
        ? ['requirements_filled', 'phone_collected']
        : [],
  },
  {
    code: 'CONTACTED',
    reasons: (s) =>
      s.customerMessageCount >= 2 || s.agentAskedQuestion
        ? [
            ...(s.customerMessageCount >= 2 ? ['customer_replied'] : []),
            ...(s.agentAskedQuestion ? ['agent_asked_question'] : []),
          ]
        : [],
  },
  { code: 'NEW', reasons: (s) => (s.created ? ['lead_created'] : []) },
];

/**
 * Proposes the stage a lead should be in, or null. Only OPEN stages of the
 * lead's pipeline whose code exists are candidates, a move is only ever
 * forward in position order, never into a closed stage, never backwards.
 */
export function proposeStage(
  signals: StageSignals,
  stages: readonly StageRef[],
  current: StageRef | null,
): StageProposal | null {
  if (current && current.kind !== 'OPEN') return null;
  const open = new Map(
    stages
      .filter((stage) => stage.kind === 'OPEN' && stage.code !== null)
      .map((stage) => [stage.code as string, stage]),
  );
  for (const rule of RULES) {
    const target = open.get(rule.code);
    if (!target) continue;
    const reasonCodes = rule.reasons(signals);
    if (reasonCodes.length === 0) continue;
    if (current && target.position <= current.position) return null;
    return { code: rule.code, reasonCodes };
  }
  return null;
}
