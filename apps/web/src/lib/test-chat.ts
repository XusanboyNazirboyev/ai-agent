/**
 * Test chat (ADR 065): the dialogue is kept here, in the browser, and sent
 * with every message; the server stores nothing.
 */

export const TEST_CHAT_HISTORY_LIMIT = 30;
export const TEST_CHAT_MAX_TEXT = 1_000;

export interface TestChatReply {
  reply: string;
  outcome: string;
  handover: string | null;
  language: string | null;
  script: string | null;
  slots: Record<string, { value: string | number; source: string }>;
  toolsUsed: string[];
  askedSlot: string | null;
}

export interface TestChatMessage {
  role: 'customer' | 'agent';
  text: string;
  /** Only on an assistant message: what it looked up and whether it would hand over. */
  handover?: string | null;
  toolsUsed?: string[];
}

export interface TestChatState {
  sessionId: string;
  messages: TestChatMessage[];
  slots: TestChatReply['slots'];
  language: string | null;
  script: string | null;
}

export function newChat(sessionId: string): TestChatState {
  return { sessionId, messages: [], slots: {}, language: null, script: null };
}

/** The request body: the newest turns only, the text trimmed and capped. */
export function requestBody(
  state: TestChatState,
  text: string,
): Record<string, unknown> {
  return {
    sessionId: state.sessionId,
    text: text.trim().slice(0, TEST_CHAT_MAX_TEXT),
    history: state.messages.slice(-TEST_CHAT_HISTORY_LIMIT).map((message) => ({
      role: message.role,
      text: message.text.slice(0, 2_000),
    })),
    slots: state.slots,
    ...(state.language ? { language: state.language } : {}),
    ...(state.script ? { script: state.script } : {}),
  };
}

/** The state after the assistant answered `text`. */
export function withReply(
  state: TestChatState,
  text: string,
  reply: TestChatReply,
): TestChatState {
  return {
    ...state,
    messages: [
      ...state.messages,
      { role: 'customer', text: text.trim() },
      {
        role: 'agent',
        text: reply.reply,
        handover: reply.handover,
        toolsUsed: reply.toolsUsed,
      },
    ],
    slots: reply.slots,
    language: reply.language ?? state.language,
    script: reply.script ?? state.script,
  };
}

const TOOL_LABELS: Record<string, string> = {
  search_catalog: 'testChat.tool.search',
  get_item_details: 'testChat.tool.details',
  list_offers: 'testChat.tool.offers',
  get_quote: 'testChat.tool.price',
  check_availability: 'testChat.tool.availability',
  knowledge_search: 'testChat.tool.knowledge',
};

/** The catalog key that words a tool in plain language, or null for one that is not shown. */
export function toolLabelKey(name: string): string | null {
  return TOOL_LABELS[name] ?? null;
}

/** The distinct, shown tool labels of a reply, in the order the tools are listed above. */
export function toolLabelKeys(names: readonly string[]): string[] {
  const keys = new Set<string>();
  for (const name of names) {
    const key = toolLabelKey(name);
    if (key) keys.add(key);
  }
  return [...keys];
}
