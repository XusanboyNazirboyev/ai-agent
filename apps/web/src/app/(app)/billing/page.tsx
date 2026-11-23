import type { ReactNode } from 'react';
import { SubscriptionPage } from '@/components/subscription-page';

/** Owner 2026-11-23: billing is its own menu item, not hidden in Settings. */
export default function Billing(): ReactNode {
  return <SubscriptionPage />;
}
