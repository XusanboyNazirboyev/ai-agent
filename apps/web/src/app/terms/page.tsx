import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { LegalPage } from '@/components/legal-page';
import { TERMS } from '@/content/legal';

export const metadata: Metadata = { title: 'Terms of service · tezda' };

export default function TermsPage(): ReactNode {
  return <LegalPage documents={TERMS} testId="terms-page" />;
}
