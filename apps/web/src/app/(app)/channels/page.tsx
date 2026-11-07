import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';

export default function Channels(): ReactNode {
  redirect('/settings/channels');
}
