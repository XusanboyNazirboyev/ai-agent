import { createHash } from 'node:crypto';
import {
  normalizeForMatching,
  type ActionField,
  type ActionSpec,
} from '@agentcore/shared';
import type { LocaleId, LocalePack } from '../locales/locale-pack.js';
import type { SlotState } from '../agent/slots.js';

/**
 * Business actions in the agent turn (ADR 022/024). Pure and generic: the
 * pack says what an action needs, tenant configuration says whether it is
 * enabled, code decides everything else. The model never writes a proposal,
 * never confirms one and never reports an outcome.
 */

/** An action the tenant has enabled and the connector can execute. */
export interface ActionCandidate {
  readonly spec: ActionSpec;
  /** Consent text per locale; present when the action sends contact data. */
  readonly consent?: Readonly<Partial<Record<LocaleId, string>>>;
}

export interface PendingProposal {
  readonly id: string;
  readonly actionKey: string;
  readonly digest: string;
}

export interface ActionTurnContext {
  readonly available: readonly ActionCandidate[];
  /** The single open, unexpired proposal of the conversation. */
  readonly pending?: PendingProposal;
  /** Action whose field the previous turn asked for. */
  readonly collecting?: string;
  /** Known contact values (including a phone written in this message). */
  readonly contact: { readonly name?: string; readonly phone?: string };
  readonly scope: {
    readonly tenantId: string;
    readonly conversationId: string;
    readonly packRef: string;
  };
}

/** Exactly the declared fields, nothing else. Values are strings. */
export type ActionPayload = Readonly<Record<string, string>>;

export type ActionDecision =
  | {
      readonly kind: 'PROPOSE';
      readonly actionKey: string;
      readonly payload: ActionPayload;
      readonly digest: string;
      readonly expiresAfterMinutes: number;
      readonly supersedes?: string;
    }
  | {
      readonly kind: 'CONFIRM';
      readonly proposalId: string;
      readonly digest: string;
    }
  | { readonly kind: 'DECLINE'; readonly proposalId: string }
  | { readonly kind: 'SUPERSEDE'; readonly proposalId: string };

export const ACTION_SLOT_PREFIX = 'action:';

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`,
      )
      .join(',')}}`;
  return JSON.stringify(value);
}

/** Binds a proposal to tenant, conversation, pack, action and exact payload. */
export function proposalDigest(
  scope: ActionTurnContext['scope'],
  actionKey: string,
  payload: ActionPayload,
): string {
  return createHash('sha256')
    .update(stable({ ...scope, actionKey, payload }))
    .digest('hex');
}

/** Whole-message confirmation or decline, any supported language; else undefined. */
export function confirmationOf(
  text: string,
  locales: readonly LocalePack[],
): 'CONFIRM' | 'DECLINE' | undefined {
  const normalized = normalizeForMatching(text).replace(
    /^[\s!.?,;:]+|[\s!.?,;:]+$/gu,
    '',
  );
  if (!normalized) return undefined;
  const matches = (phrases: readonly string[]): boolean =>
    phrases.some((phrase) => normalizeForMatching(phrase) === normalized);
  if (locales.some((pack) => matches(pack.actionConfirmPhrases)))
    return 'CONFIRM';
  if (locales.some((pack) => matches(pack.actionDeclinePhrases)))
    return 'DECLINE';
  return undefined;
}

function fieldValue(
  field: ActionField,
  slots: SlotState,
  contact: ActionTurnContext['contact'],
): string | undefined {
  if (field.from.kind === 'slot') {
    const value = slots[field.from.slot]?.value;
    if (value === undefined || value === null) return undefined;
    const text = String(value).trim();
    return text.length > 0 && text.length <= 200 ? text : undefined;
  }
  const value = contact[field.from.field]?.trim();
  if (!value) return undefined;
  return field.from.field === 'phone'
    ? /^\+?\d{9,15}$/u.test(value)
      ? value
      : undefined
    : value.length <= 120
      ? value
      : undefined;
}

export type ActionPlan =
  | { readonly kind: 'ASK'; readonly field: ActionField }
  | { readonly kind: 'READY'; readonly payload: ActionPayload };

/** The first missing required field, or the minimal payload. */
export function planAction(
  spec: ActionSpec,
  slots: SlotState,
  contact: ActionTurnContext['contact'],
): ActionPlan {
  const payload: Record<string, string> = {};
  for (const field of spec.fields) {
    const value = fieldValue(field, slots, contact);
    if (value === undefined) {
      if (field.required) return { kind: 'ASK', field };
      continue;
    }
    payload[field.name] = value;
  }
  return { kind: 'READY', payload };
}

export function sendsContactData(spec: ActionSpec): boolean {
  return spec.fields.some((field) => field.from.kind === 'contact');
}

/** Code-rendered proposal: title, every value that will be sent, consent, how to confirm. */
export function renderProposal(
  candidate: ActionCandidate,
  payload: ActionPayload,
  locale: LocalePack,
): string {
  const { spec } = candidate;
  const lines = [
    `${locale.templates.actions.proposalIntro} ${spec.title[locale.id] ?? spec.key}`,
  ];
  for (const field of spec.fields) {
    const value = payload[field.name];
    if (value !== undefined)
      lines.push(`• ${field.label[locale.id] ?? field.name}: ${value}`);
  }
  const consent = candidate.consent?.[locale.id];
  if (consent) lines.push(consent);
  lines.push(
    locale.templates.actions.confirmPrompt
      .replace('{yes}', locale.actionConfirmPhrases[0] ?? '')
      .replace('{no}', locale.actionDeclinePhrases[0] ?? ''),
  );
  return lines.join('\n');
}
