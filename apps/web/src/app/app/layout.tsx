import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { signInUrl } from '@/lib/return-to';
import { getSessionUser } from '@/lib/session';
import { RETURN_TO_HEADER } from '@/proxy';

// One guard for every present and future `/app/**` page (spec 124, decision 4).
// A guest comes back to the page they asked for (spec 135, decision 6).
export default async function AppLayout({ children }: { children: ReactNode }) {
  if (!(await getSessionUser())) {
    redirect(signInUrl((await headers()).get(RETURN_TO_HEADER) ?? undefined));
  }
  return children;
}
