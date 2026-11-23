import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';

/** Owner 2026-11-23: moved to the AI agent section; old links keep working. */
export default function Moved(): ReactNode {
  redirect('/agent/test');
}
