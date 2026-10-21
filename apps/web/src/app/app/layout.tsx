import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { getSessionUser } from '@/lib/session';

// One guard for every present and future `/app/**` page (spec 124, decision 4).
export default async function AppLayout({ children }: { children: ReactNode }) {
  if (!(await getSessionUser())) redirect('/sign-in');
  return children;
}
