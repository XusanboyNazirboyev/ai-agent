import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { SalesSite } from '@/components/sales-site';
import en from '@/i18n/en.json';

export const metadata: Metadata = {
  title: en['site.metaTitle'],
  description: en['site.metaDescription'],
  robots: { index: true, follow: true },
};

export default function Home(): ReactNode {
  return <SalesSite />;
}
