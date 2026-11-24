import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';

/** Owner 2026-11-24: channels are their own menu section now. */
export default function Moved(): ReactNode {
  redirect('/channels/telegram');
}
