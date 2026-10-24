/** Flattens JSON from the API into display lines; only primitives, depth 2. */
export function factLines(value: unknown, prefix = '', depth = 0): string[] {
  if (value === null || value === undefined) return [];
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  )
    return [prefix ? `${prefix}: ${String(value)}` : String(value)];
  if (depth >= 2) return [];
  if (Array.isArray(value))
    return value
      .flatMap((entry) => factLines(entry, prefix, depth + 1))
      .slice(0, 20);
  if (typeof value === 'object')
    return Object.entries(value as Record<string, unknown>)
      .flatMap(([key, entry]) => factLines(entry, key, depth + 1))
      .slice(0, 20);
  return [];
}
