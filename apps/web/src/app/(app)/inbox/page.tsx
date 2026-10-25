import { Suspense, type ReactNode } from 'react';
import { InboxApp } from '@/components/inbox-app';

export default function InboxPage(): ReactNode {
  return (
    <Suspense fallback={null}>
      <InboxApp />
    </Suspense>
  );
}
