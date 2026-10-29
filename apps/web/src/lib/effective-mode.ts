import type { AgentMode, EffectiveMode } from './types';

/**
 * Which "what really happens" notice the bot page shows for an account.
 * The server computes effectiveMode with the same function the pipeline
 * uses; the page only decides whether the two differ in a way the operator
 * must be told about. A mode that runs as requested shows nothing, and OFF
 * is never degraded (the server never turns another mode into OFF).
 */
export function effectiveNotice(account: {
  readonly agentMode: AgentMode;
  readonly effectiveMode: EffectiveMode;
}): 'SHADOW' | 'HOLD' | null {
  if (account.effectiveMode === account.agentMode) return null;
  return account.effectiveMode === 'SHADOW' || account.effectiveMode === 'HOLD'
    ? account.effectiveMode
    : null;
}
