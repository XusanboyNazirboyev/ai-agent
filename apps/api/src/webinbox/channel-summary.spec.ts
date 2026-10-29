import { describe, expect, it } from 'vitest';
import {
  effectiveAgentMode,
  type AgentModePolicy,
  type AgentModeValue,
} from '../agent/agent-mode.js';
import { summarizeChannel, type ChannelRow } from './channel-summary.js';

const MODES: AgentModeValue[] = ['OFF', 'SHADOW', 'LIVE'];

function row(agentMode: AgentModeValue, isTestAccount: boolean): ChannelRow {
  return {
    id: 'channel-1',
    channelType: 'telegram',
    displayName: null,
    status: 'ACTIVE',
    agentMode,
    isTestAccount,
    operatorChatId: null,
    createdAt: new Date('2026-10-28T00:00:00Z'),
  };
}

/** Every combination the policy can take, so no case is left to chance. */
function policies(): AgentModePolicy[] {
  const out: AgentModePolicy[] = [];
  for (const nodeEnv of ['development', 'test', 'production'] as const)
    for (const providerTrusted of [true, false])
      for (const allowRealCustomerData of [true, false])
        for (const operatorNotifierConfigured of [true, false])
          out.push({
            nodeEnv,
            providerTrusted,
            allowRealCustomerData,
            operatorNotifierConfigured,
          });
  return out;
}

describe('channel summary: requested vs effective mode', () => {
  it('shows exactly the mode the pipeline applies, for every policy, mode and account kind', () => {
    let checked = 0;
    for (const policy of policies())
      for (const mode of MODES)
        for (const isTestAccount of [true, false]) {
          const account = row(mode, isTestAccount);
          const summary = summarizeChannel(account, policy, 'none');
          const pipeline = effectiveAgentMode(mode, policy, account).mode;
          expect(summary.effectiveMode).toBe(pipeline);
          checked += 1;
        }
    expect(checked).toBe(144);
  });

  it('explains every difference with a reason, and gives none when nothing differs', () => {
    for (const policy of policies())
      for (const mode of MODES)
        for (const isTestAccount of [true, false]) {
          const summary = summarizeChannel(
            row(mode, isTestAccount),
            policy,
            'none',
          );
          if (summary.effectiveMode === mode)
            expect(summary.effectiveReason).toBeUndefined();
          else expect(summary.effectiveReason).toBeDefined();
        }
  });

  it('LIVE on an untrusted provider: a test account only drafts, a real account is held (customers get no reply)', () => {
    const untrusted: AgentModePolicy = {
      nodeEnv: 'development',
      providerTrusted: false,
      allowRealCustomerData: false,
      operatorNotifierConfigured: false,
    };
    const test = summarizeChannel(row('LIVE', true), untrusted, 'none');
    expect(test).toMatchObject({
      agentMode: 'LIVE',
      effectiveMode: 'SHADOW',
      effectiveReason: 'UNTRUSTED_PROVIDER',
    });
    const real = summarizeChannel(row('LIVE', false), untrusted, 'none');
    expect(real).toMatchObject({
      agentMode: 'LIVE',
      effectiveMode: 'HOLD',
      effectiveReason: 'UNTRUSTED_PROVIDER',
    });
  });

  it('SHADOW on a real account with an untrusted provider is held with the real-customer-data reason', () => {
    const untrusted: AgentModePolicy = {
      nodeEnv: 'production',
      providerTrusted: false,
      allowRealCustomerData: false,
      operatorNotifierConfigured: false,
    };
    expect(
      summarizeChannel(row('SHADOW', false), untrusted, 'none'),
    ).toMatchObject({
      effectiveMode: 'HOLD',
      effectiveReason: 'UNTRUSTED_REAL_DATA',
    });
  });
});
