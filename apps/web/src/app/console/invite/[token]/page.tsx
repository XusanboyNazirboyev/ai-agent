import type { ReactNode } from 'react';
import { InviteAccept } from '@/components/invite-accept';

export default function Page(): ReactNode {
  return <InviteAccept kind="platform" />;
}
