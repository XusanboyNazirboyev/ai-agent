import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { LegalPage } from '@/components/legal-page';
import { DATA_DELETION } from '@/content/legal';

export const metadata: Metadata = { title: 'Data deletion · tezda' };

export default function DataDeletionPage(): ReactNode {
  return <LegalPage documents={DATA_DELETION} testId="data-deletion-page" />;
}
