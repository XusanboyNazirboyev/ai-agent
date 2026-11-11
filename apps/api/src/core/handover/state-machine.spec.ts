import { describe, expect, it } from 'vitest';
import {
  botMaySpeak,
  nextState,
  operatorMaySpeak,
  type ConversationState,
  type OwnershipCommand,
} from './state-machine.js';

describe('state-machine (D12 ownership)', () => {
  const cases: Array<
    [ConversationState, OwnershipCommand, ConversationState | undefined]
  > = [
    ['BOT_ACTIVE', 'HANDOVER', 'WAITING_OPERATOR'],
    ['WAITING_OPERATOR', 'TAKE_OVER', 'OPERATOR_ACTIVE'],
    ['BOT_ACTIVE', 'TAKE_OVER', 'OPERATOR_ACTIVE'],
    ['WAITING_OPERATOR', 'RETURN_TO_BOT', 'BOT_ACTIVE'],
    ['OPERATOR_ACTIVE', 'RETURN_TO_BOT', 'BOT_ACTIVE'],
    ['BOT_ACTIVE', 'CLOSE', 'CLOSED'],
    ['WAITING_OPERATOR', 'CLOSE', 'CLOSED'],
    ['OPERATOR_ACTIVE', 'CLOSE', 'CLOSED'],
    ['CLOSED', 'REOPEN', 'BOT_ACTIVE'],
    ['WAITING_OPERATOR', 'HANDOVER', undefined],
    ['OPERATOR_ACTIVE', 'HANDOVER', undefined],
    ['CLOSED', 'HANDOVER', undefined],
    ['OPERATOR_ACTIVE', 'TAKE_OVER', undefined],
    ['CLOSED', 'TAKE_OVER', undefined],
    ['BOT_ACTIVE', 'RETURN_TO_BOT', undefined],
    ['CLOSED', 'RETURN_TO_BOT', undefined],
    ['CLOSED', 'CLOSE', undefined],
    ['BOT_ACTIVE', 'REOPEN', undefined],
    ['WAITING_OPERATOR', 'REOPEN', undefined],
    ['OPERATOR_ACTIVE', 'REOPEN', undefined],
  ];

  it.each(cases)('nextState(%s, %s) -> %s', (state, command, expected) => {
    expect(nextState(state, command)).toBe(expected);
  });

  it('bot may speak only in BOT_ACTIVE', () => {
    expect(botMaySpeak('BOT_ACTIVE')).toBe(true);
    expect(botMaySpeak('WAITING_OPERATOR')).toBe(false);
    expect(botMaySpeak('OPERATOR_ACTIVE')).toBe(false);
    expect(botMaySpeak('CLOSED')).toBe(false);
  });

  it('operator may speak only in OPERATOR_ACTIVE', () => {
    expect(operatorMaySpeak('OPERATOR_ACTIVE')).toBe(true);
    expect(operatorMaySpeak('BOT_ACTIVE')).toBe(false);
    expect(operatorMaySpeak('WAITING_OPERATOR')).toBe(false);
    expect(operatorMaySpeak('CLOSED')).toBe(false);
  });
});
