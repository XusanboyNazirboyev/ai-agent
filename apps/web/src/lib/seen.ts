const KEY = 'ac_seen';

function read(): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(
      window.localStorage.getItem(KEY) ?? '{}',
    );
    return parsed && typeof parsed === 'object'
      ? (parsed as Record<string, string>)
      : {};
  } catch {
    return {};
  }
}

/** Per-browser "last seen" marks; unread markers are a convenience, not state. */
export function markSeen(id: string, updatedAt: string): void {
  try {
    const all = read();
    all[id] = updatedAt;
    const entries = Object.entries(all).slice(-500);
    window.localStorage.setItem(
      KEY,
      JSON.stringify(Object.fromEntries(entries)),
    );
  } catch {
    // Storage blocked: markers simply stay off.
  }
}

export function isUnread(id: string, updatedAt: string): boolean {
  const seen = read()[id];
  return seen === undefined ? true : seen < updatedAt;
}
