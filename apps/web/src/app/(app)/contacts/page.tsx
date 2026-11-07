import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';

export default function Contacts(): ReactNode {
  redirect('/leads?view=list');
}
