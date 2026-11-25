import { redirect } from 'next/navigation';

/** ADR 096: one sign-in page; the account decides which panel opens. */
export default function Page(): never {
  redirect('/login');
}
