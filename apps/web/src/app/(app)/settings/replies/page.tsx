import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';

/** Owner 2026-11-24: quick replies moved to the Channels section. */
export default function Moved(): ReactNode {
  redirect('/channels/replies');
}
