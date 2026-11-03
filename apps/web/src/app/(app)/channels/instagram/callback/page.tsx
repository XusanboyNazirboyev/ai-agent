import { Suspense, type ReactNode } from 'react';
import { InstagramOAuthCallback } from '@/components/instagram-oauth-callback';

export default function InstagramCallback(): ReactNode {
  return (
    <Suspense>
      <InstagramOAuthCallback />
    </Suspense>
  );
}
