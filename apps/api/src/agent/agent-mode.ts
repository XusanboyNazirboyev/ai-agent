/**
 * Agent mode per channel account (OFF | SHADOW | LIVE).
 *
 * LIVE sends agent replies and handover notices to customers, which is only
 * acceptable when operators are notified of handovers. That notifier is
 * Phase 5 and does not exist yet, so LIVE is refused everywhere except
 * local development. SHADOW never sends anything to the customer.
 */

export type AgentModeValue = 'OFF' | 'SHADOW' | 'LIVE';

/** Phase 5 builds the operator handover notifier; until then: false. */
export const OPERATOR_HANDOVER_NOTIFIER_AVAILABLE = false;

/** Nest token to override the policy (tests); default reads NODE_ENV. */
export const AGENT_MODE_POLICY = Symbol('AGENT_MODE_POLICY');

export interface AgentModePolicy {
  readonly nodeEnv: 'development' | 'test' | 'production';
  readonly operatorNotifierConfigured: boolean;
}

export const DEFAULT_AGENT_MODE_POLICY = (
  nodeEnv: AgentModePolicy['nodeEnv'],
): AgentModePolicy => ({
  nodeEnv,
  operatorNotifierConfigured: OPERATOR_HANDOVER_NOTIFIER_AVAILABLE,
});

export class AgentModeRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentModeRefusedError';
  }
}

/** Why LIVE is not allowed under `policy`, or undefined when it is. */
export function liveModeRefusal(policy: AgentModePolicy): string | undefined {
  if (policy.operatorNotifierConfigured) return undefined;
  if (policy.nodeEnv === 'development') return undefined;
  return (
    'Agent mode LIVE requires an operator handover notifier, which is not ' +
    'implemented yet (Phase 5). Use SHADOW, or LIVE only with ' +
    'NODE_ENV=development on a local test bot.'
  );
}

/** Throws AgentModeRefusedError when `mode` may not be enabled. */
export function assertAgentModeAllowed(
  mode: AgentModeValue,
  policy: AgentModePolicy,
): void {
  if (mode !== 'LIVE') return;
  const refusal = liveModeRefusal(policy);
  if (refusal) throw new AgentModeRefusedError(refusal);
}

/**
 * Mode actually applied at processing time. A LIVE row that is not allowed
 * (e.g. changed in the database after startup) degrades to SHADOW, so the
 * agent never sends without operator notification.
 */
export function effectiveAgentMode(
  mode: AgentModeValue,
  policy: AgentModePolicy,
): { readonly mode: AgentModeValue; readonly refusal?: string } {
  if (mode !== 'LIVE') return { mode };
  const refusal = liveModeRefusal(policy);
  return refusal ? { mode: 'SHADOW', refusal } : { mode };
}
