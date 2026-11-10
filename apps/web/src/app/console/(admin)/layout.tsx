import { Suspense, type ReactNode } from 'react';
import { ConsoleShell } from '@/components/console/console-shell';

export default function ConsoleLayout({
  children,
}: {
  children: ReactNode;
}): ReactNode {
  return (
    <Suspense fallback={null}>
      <ConsoleShell>{children}</ConsoleShell>
    </Suspense>
  );
}
