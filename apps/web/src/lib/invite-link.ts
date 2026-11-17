/**
 * An invite link is shown exactly once (ADR 047 §5): the API returns a
 * relative path with the plain token; the page turns it into a full link on
 * this origin. Only `/invite/…`, `/console/invite/…` and `/reset/…` (password
 * reset links, ADR 047 amendment 2026-11-17) paths are accepted, so
 * a malformed response can never become a link elsewhere.
 */
export function inviteUrl(path: string, origin: string): string | undefined {
  if (!/^\/(?:(?:console\/)?invite|reset)\/[A-Za-z0-9_-]+$/u.test(path))
    return undefined;
  return new URL(path, origin).toString();
}
