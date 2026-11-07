import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';

export default function Crm(): ReactNode {
  redirect('/settings/crm');
}
