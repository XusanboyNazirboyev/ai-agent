/**
 * Decides whether a reply may be spoken (ADR 055). Pure.
 *
 * A number said aloud may be misheard and the written text is the source of
 * truth (AGENTS.md rules 2 and 8), so in this stage a reply that carries
 * facts, figures or contact data is never spoken. A text+voice combination is
 * an open decision for S2.
 */
import { FACT_REFERENCE } from "../../core/agent/facts.js";
import { languagePrefix } from "./ports.js";
import {
  TTS_DEFAULT_MAX_CHARS,
  VOXCPM_SUPPORTED_LANGUAGES,
} from "./voxcpm-tts.js";

export type SpeechChannel = "telegram" | "instagram";

export interface SpeechSettings {
  /** Channels on which this tenant allows spoken replies; empty = off. */
  readonly enabledChannels: readonly SpeechChannel[];
  readonly maxChars?: number;
  /** Languages the active provider supports; default ru, en. */
  readonly supportedLanguages?: readonly string[];
}

export type NoSpeechReason =
  | "DISABLED"
  | "EMPTY_REPLY"
  | "UNSUPPORTED_LANGUAGE"
  | "TOO_LONG"
  | "CONTAINS_FACTS"
  | "CONTAINS_LINK_OR_CONTACT";

export type SpeechDecision =
  { speak: true } | { speak: false; reason: NoSpeechReason };

export interface SpeechPolicyInput {
  readonly replyText: string;
  readonly language: string;
  readonly channel: SpeechChannel;
  readonly settings: SpeechSettings;
}

const DIGIT = /\p{Nd}/u;
const CURRENCY_SYMBOL = /[\p{Sc}%№]/u;
const CURRENCY_WORD =
  /(?:^|[^\p{L}])(?:usd|eur|uzs|rub|sum|so['’ʼ`]?m|som|dollar\w*|euro|ruble\w*|руб\w*|сум\w*|сўм|доллар\w*|евро|процент\w*|percent|tiyin|тийин|копе\w*)(?=$|[^\p{L}])/iu;
const URL_LIKE =
  /(?:https?:\/\/|www\.|\b[\p{L}\d-]+\.(?:com|org|net|io|uz|ru|me|app|dev)\b|t\.me\/)/iu;
const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/u;
const HANDLE = /(?:^|\s)@[\p{L}\d_]{2,}/u;

export function decideSpeech(input: SpeechPolicyInput): SpeechDecision {
  const { settings } = input;
  if (!settings.enabledChannels.includes(input.channel)) {
    return { speak: false, reason: "DISABLED" };
  }
  const text = input.replyText.trim();
  if (text.length === 0) return { speak: false, reason: "EMPTY_REPLY" };
  const languages = settings.supportedLanguages ?? VOXCPM_SUPPORTED_LANGUAGES;
  if (!languages.includes(languagePrefix(input.language))) {
    return { speak: false, reason: "UNSUPPORTED_LANGUAGE" };
  }
  if (text.length > (settings.maxChars ?? TTS_DEFAULT_MAX_CHARS)) {
    return { speak: false, reason: "TOO_LONG" };
  }
  FACT_REFERENCE.lastIndex = 0;
  if (
    FACT_REFERENCE.test(text) ||
    DIGIT.test(text) ||
    CURRENCY_SYMBOL.test(text) ||
    CURRENCY_WORD.test(text)
  ) {
    FACT_REFERENCE.lastIndex = 0;
    return { speak: false, reason: "CONTAINS_FACTS" };
  }
  if (URL_LIKE.test(text) || EMAIL.test(text) || HANDLE.test(text)) {
    return { speak: false, reason: "CONTAINS_LINK_OR_CONTACT" };
  }
  return { speak: true };
}
