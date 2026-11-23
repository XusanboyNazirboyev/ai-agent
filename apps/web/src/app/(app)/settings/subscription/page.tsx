import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';

/**
 * Owner 2026-11-23: moved to /billing. Payments started before the move still
 * return here with `?paid=1`, so the query is kept.
 */
export default async function Moved(props: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactNode> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(await props.searchParams))
    for (const one of Array.isArray(value) ? value : value ? [value] : [])
      query.append(key, one);
  const search = query.toString();
  redirect(search ? `/billing?${search}` : '/billing');
}
