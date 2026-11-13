import { z } from "zod";
import { extractPhone } from "./phone.js";
import {
  amountCurrencyPaired,
  isAmount,
  isCurrency,
  MAX_SOURCE,
} from "../pipelines/pipeline-rules.js";

/**
 * Pure rules of a lead added by hand (ADR 061). No database access.
 */

/** `channel_type` of the per-tenant internal channel account. */
export const MANUAL_CHANNEL_TYPE = "manual";
export const MAX_MANUAL_NAME = 200;
export const MAX_MANUAL_NOTE = 1000;
export const MANUAL_DEFAULT_SOURCE = "manual";

/** True for the internal channel type that is never a real channel. */
export function isManualChannelType(channelType: string): boolean {
  return channelType === MANUAL_CHANNEL_TYPE;
}

/**
 * `channel_accounts` is unique on (channel_type, external_account_id) across
 * ALL tenants, so the internal account id carries the tenant id.
 */
export function manualExternalAccountId(tenantId: string): string {
  return `${MANUAL_CHANNEL_TYPE}:${tenantId}`;
}

/** Ids of the rows created for one manual lead (all share one uuid). */
export function manualIdentifiers(uuid: string): {
  providerUserId: string;
  providerChatId: string;
  idempotencyKey: string;
} {
  const key = `${MANUAL_CHANNEL_TYPE}:${uuid}`;
  return { providerUserId: key, providerChatId: key, idempotencyKey: key };
}

const ManualLeadBody = z
  .object({
    name: z.string().trim().min(1).max(MAX_MANUAL_NAME),
    phone: z.string().max(60).optional(),
    pipelineId: z.string().uuid().optional(),
    stageId: z.string().uuid().optional(),
    amount: z.string().optional(),
    currency: z.string().optional(),
    source: z.string().trim().max(MAX_SOURCE).optional(),
    ownerOperatorId: z.string().uuid().optional(),
    note: z.string().max(MAX_MANUAL_NOTE).optional(),
    tagIds: z.array(z.string().uuid()).max(100).optional(),
  })
  .strict();

export interface ManualLeadInput {
  readonly name: string;
  /** Normalised (`+998...`), or undefined when none was given. */
  readonly phone: string | undefined;
  readonly pipelineId: string | undefined;
  readonly stageId: string | undefined;
  readonly amount: string | undefined;
  readonly currency: string | undefined;
  /** Trimmed; an empty source becomes `manual`. */
  readonly source: string;
  readonly ownerOperatorId: string | undefined;
  readonly note: string;
  readonly tagIds: readonly string[];
}

export type ManualLeadParse =
  | { ok: true; input: ManualLeadInput }
  | { ok: false; code: "INVALID_BODY" | "INVALID_VALUE" };

/**
 * Shape and value checks that need no database: strict body, normalised
 * phone (invalid -> INVALID_VALUE), decimal-string amount and listed
 * currency set together or not at all.
 */
export function parseManualLeadBody(body: unknown): ManualLeadParse {
  const parsed = ManualLeadBody.safeParse(body);
  if (!parsed.success) return { ok: false, code: "INVALID_BODY" };
  const raw = parsed.data;
  let phone: string | undefined;
  if (raw.phone !== undefined && raw.phone.trim() !== "") {
    phone = extractPhone(raw.phone);
    if (phone === undefined) return { ok: false, code: "INVALID_VALUE" };
  }
  if (!amountCurrencyPaired(raw.amount, raw.currency))
    return { ok: false, code: "INVALID_VALUE" };
  if (
    raw.amount !== undefined &&
    (!isAmount(raw.amount) || !isCurrency(raw.currency))
  )
    return { ok: false, code: "INVALID_VALUE" };
  return {
    ok: true,
    input: {
      name: raw.name,
      phone,
      pipelineId: raw.pipelineId,
      stageId: raw.stageId,
      amount: raw.amount,
      currency: raw.currency,
      source:
        raw.source && raw.source !== "" ? raw.source : MANUAL_DEFAULT_SOURCE,
      ownerOperatorId: raw.ownerOperatorId,
      note: raw.note ?? "",
      tagIds: [...new Set(raw.tagIds ?? [])],
    },
  };
}

export type StageChoice =
  | { ok: true; stageId: string; pipelineId: string }
  | { ok: false; code: "NOT_FOUND" | "INVALID_VALUE" | "STAGE_NOT_OPEN" };

export interface StageRow {
  readonly id: string;
  readonly pipelineId: string;
  readonly kind: "OPEN" | "WON" | "LOST";
}

/**
 * Decides the stage of a new manual lead from the named stage (already
 * loaded, null when unknown/other tenant/archived) and the requested
 * pipeline. A stage of another pipeline than the one named is INVALID_VALUE;
 * a WON/LOST stage is STAGE_NOT_OPEN (a lead is never created closed).
 */
export function chooseStage(
  stage: StageRow | null,
  requestedPipelineId: string | undefined,
): StageChoice {
  if (!stage) return { ok: false, code: "NOT_FOUND" };
  if (requestedPipelineId && requestedPipelineId !== stage.pipelineId)
    return { ok: false, code: "INVALID_VALUE" };
  if (stage.kind !== "OPEN") return { ok: false, code: "STAGE_NOT_OPEN" };
  return { ok: true, stageId: stage.id, pipelineId: stage.pipelineId };
}
