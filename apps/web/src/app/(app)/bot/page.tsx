import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';

export default function Bot(): ReactNode {
  redirect('/settings/bot');
}
