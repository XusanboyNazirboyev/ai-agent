/**
 * Agent mode per channel account (OFF | SHADOW | LIVE) and the rules that
 * decide which mode may actually run.
 *
 * - LIVE sends agent replies and handover notices to customers, which is
 *   only acceptable when operators are notified of handovers. That notifier
 *   is Phase 5, so LIVE is refused everywhere except local development.
 * - Data protection: a provider not listed in LLM_TRUSTED_PROVIDERS (by
 *   default every provider except the offline mock) may never run LIVE, and
 *   may run SHADOW on a real (non-test) channel account only with
 *   LLM_ALLOW_REAL_CUSTOMER_DATA=true. Free tiers may use prompts to
 *   improve their products.
 * - A mode that may not run degrades: LIVE to SHADOW when SHADOW is allowed,
 *   otherwise to HOLD (the batch is closed; no model call, nothing sent).
 *   The Phase 2 echo (OFF) is never used as a fallback because it would
 *   reply to real customers.
 */

export type AgentModeValue = 'OFF' | 'SHADOW' | 'LIVE';
export type EffectiveAgentMode = AgentModeValue | 'HOLD';

/** Phase 5 builds the operator handover notifier; until then: false. */
export const OPERATOR_HANDOVER_NOTIFIER_AVAILABLE = false;

/** Nest token to override the policy (tests); default reads config. */
export const AGENT_MODE_POLICY = Symbol('AGENT_MODE_POLICY');

export interface AgentModePolicy {
  readonly nodeEnv: 'development' | 'test' | 'production';
  readonly operatorNotifierConfigured: boolean;
  /** The configured LLM provider is listed in LLM_TRUSTED_PROVIDERS. */
  readonly providerTrusted: boolean;
  /** LLM_ALLOW_REAL_CUSTOMER_DATA override for untrusted providers. */
  readonly allowRealCustomerData: boolean;
}

export interface AgentModeAccount {
  readonly isTestAccount: boolean;
}

export function agentModePolicy(settings: {
  readonly NODE_ENV: AgentModePolicy['nodeEnv'];
  readonly LLM_PROVIDER: string;
  readonly LLM_TRUSTED_PROVIDERS: readonly string[];
  readonly LLM_ALLOW_REAL_CUSTOMER_DATA: boolean;
}): AgentModePolicy {
  return {
    nodeEnv: settings.NODE_ENV,
    operatorNotifierConfigured: OPERATOR_HANDOVER_NOTIFIER_AVAILABLE,
    providerTrusted: settings.LLM_TRUSTED_PROVIDERS.includes(
      settings.LLM_PROVIDER,
    ),
    allowRealCustomerData: settings.LLM_ALLOW_REAL_CUSTOMER_DATA,
  };
}

export class AgentModeRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentModeRefusedError';
  }
}

/** Why LIVE is not allowed under `policy`, or undefined when it is. */
export function liveModeRefusal(policy: AgentModePolicy): string | undefined {
  if (!policy.providerTrusted) {
    return (
      'Agent mode LIVE is refused for an untrusted LLM provider (not in ' +
      'LLM_TRUSTED_PROVIDERS); free tiers may use prompts for training.'
    );
  }
  if (policy.operatorNotifierConfigured) return undefined;
  if (policy.nodeEnv === 'development') return undefined;
  return (
    'Agent mode LIVE requires an operator handover notifier, which is not ' +
    'implemented yet (Phase 5). Use SHADOW, or LIVE only with ' +
    'NODE_ENV=development on a local test bot.'
  );
}

/** Why SHADOW is not allowed on `account`, or undefined when it is. */
export function shadowModeRefusal(
  policy: AgentModePolicy,
  account: AgentModeAccount,
): string | undefined {
  if (policy.providerTrusted || account.isTestAccount) return undefined;
  if (policy.allowRealCustomerData) return undefined;
  return (
    'Agent mode SHADOW on a real channel account sends customer messages ' +
    'to an untrusted LLM provider; mark the account as a test account or ' +
    'set LLM_ALLOW_REAL_CUSTOMER_DATA=true explicitly.'
  );
}

/**
 * Machine-readable reason a mode may not be enabled (for UIs that translate
 * it), or undefined when it may. Mirrors liveModeRefusal / shadowModeRefusal.
 */
export type ModeRefusalCode =
  'UNTRUSTED_PROVIDER' | 'NO_OPERATOR_NOTIFIER' | 'UNTRUSTED_REAL_DATA';

export function modeRefusalCode(
  mode: AgentModeValue,
  policy: AgentModePolicy,
  account: AgentModeAccount,
): ModeRefusalCode | undefined {
  if (mode === 'OFF') return undefined;
  if (mode === 'LIVE') {
    if (!policy.providerTrusted) return 'UNTRUSTED_PROVIDER';
    return liveModeRefusal(policy) ? 'NO_OPERATOR_NOTIFIER' : undefined;
  }
  return shadowModeRefusal(policy, account) ? 'UNTRUSTED_REAL_DATA' : undefined;
}

/** Throws AgentModeRefusedError when `mode` may not be enabled. */
export function assertAgentModeAllowed(
  mode: AgentModeValue,
  policy: AgentModePolicy,
  account: AgentModeAccount,
): void {
  if (mode === 'OFF') return;
  const refusal =
    mode === 'LIVE'
      ? liveModeRefusal(policy)
      : shadowModeRefusal(policy, account);
  if (refusal) throw new AgentModeRefusedError(refusal);
}

/**
 * Mode actually applied at processing time (rows may change after
 * startup). Never more permissive than the configured mode.
 */
export function effectiveAgentMode(
  mode: AgentModeValue,
  policy: AgentModePolicy,
  account: AgentModeAccount,
): { readonly mode: EffectiveAgentMode; readonly refusal?: string } {
  if (mode === 'OFF') return { mode };
  const live = mode === 'LIVE' ? liveModeRefusal(policy) : undefined;
  const shadow = shadowModeRefusal(policy, account);
  if (mode === 'LIVE' && !live) return { mode };
  if (shadow) return { mode: 'HOLD', refusal: live ?? shadow };
  return live ? { mode: 'SHADOW', refusal: live } : { mode: 'SHADOW' };
}
