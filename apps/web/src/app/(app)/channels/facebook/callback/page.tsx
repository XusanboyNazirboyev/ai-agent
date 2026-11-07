import { Suspense, type ReactNode } from 'react';
import { InstagramOAuthCallback } from '@/components/instagram-oauth-callback';

export default function FacebookCallback(): ReactNode {
  return (
    <Suspense>
      <InstagramOAuthCallback channel="facebook" />
    </Suspense>
  );
}
