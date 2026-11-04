import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { LegalPage } from '@/components/legal-page';
import { PRIVACY } from '@/content/legal';

export const metadata: Metadata = { title: 'Privacy policy · tezda' };

export default function PrivacyPage(): ReactNode {
  return <LegalPage documents={PRIVACY} testId="privacy-page" />;
}
