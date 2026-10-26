import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { AppShell } from '@/components/shell/app-shell';
import { signInUrl } from '@/lib/return-to';
import { getRunners, getSessionUser } from '@/lib/session';
import { RETURN_TO_HEADER } from '@/proxy';

// One guard for every present and future `/app/**` page (spec 124, decision 4).
// A guest comes back to the page they asked for (spec 135, decision 6).
export default async function AppLayout({ children }: { children: ReactNode }) {
  const user = await getSessionUser();
  if (!user) {
    redirect(signInUrl((await headers()).get(RETURN_TO_HEADER) ?? undefined));
  }
  // For the sidebar's machine status (spec #373): read when the layout
  // renders, shared with the page through the request cache; no polling.
  const runners = await getRunners();
  return (
    <AppShell
      email={user.email}
      emailVerified={user.emailVerified}
      runners={runners}
    >
      {children}
    </AppShell>
  );
}
