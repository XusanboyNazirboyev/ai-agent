import type { ReactNode } from 'react';
import { LeadPage } from '@/components/lead-page';

export default async function LeadDetailPage(props: {
  params: Promise<{ id: string }>;
}): Promise<ReactNode> {
  const { id } = await props.params;
  return <LeadPage leadId={id} />;
}
