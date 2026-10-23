/**
 * Conversation ownership state machine (D12, spec §7.4). Pure: it decides
 * whether a command is legal and what state follows. Persistence, locking,
 * authorization and notification live in the handover service; routing and
 * model providers never decide ownership.
 */
export type ConversationState =
  'BOT_ACTIVE' | 'WAITING_OPERATOR' | 'OPERATOR_ACTIVE' | 'CLOSED';

export type OwnershipCommand =
  /** The bot escalates (any handover reason). */
  | 'HANDOVER'
  /** An operator claims a waiting conversation. */
  | 'TAKE_OVER'
  /** The operator gives the conversation back to the bot. */
  | 'RETURN_TO_BOT'
  | 'CLOSE'
  /** The customer writes to a closed conversation. */
  | 'REOPEN';

const TRANSITIONS: Readonly<
  Record<
    OwnershipCommand,
    Partial<Record<ConversationState, ConversationState>>
  >
> = {
  HANDOVER: { BOT_ACTIVE: 'WAITING_OPERATOR' },
  TAKE_OVER: { WAITING_OPERATOR: 'OPERATOR_ACTIVE' },
  RETURN_TO_BOT: {
    WAITING_OPERATOR: 'BOT_ACTIVE',
    OPERATOR_ACTIVE: 'BOT_ACTIVE',
  },
  CLOSE: {
    BOT_ACTIVE: 'CLOSED',
    WAITING_OPERATOR: 'CLOSED',
    OPERATOR_ACTIVE: 'CLOSED',
  },
  REOPEN: { CLOSED: 'BOT_ACTIVE' },
};

/** The next state, or undefined when the command is not legal in `state`. */
export function nextState(
  state: ConversationState,
  command: OwnershipCommand,
): ConversationState | undefined {
  return TRANSITIONS[command][state];
}

/** The bot may answer the customer only while it owns the conversation. */
export function botMaySpeak(state: ConversationState): boolean {
  return state === 'BOT_ACTIVE';
}

/** Operator replies are legal only while an operator owns the conversation. */
export function operatorMaySpeak(state: ConversationState): boolean {
  return state === 'OPERATOR_ACTIVE';
}
