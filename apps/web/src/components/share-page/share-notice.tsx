import { Card } from '@andrewbehma/glass-ui/card';
import type { ReactNode } from 'react';
import { MadeWithBadge } from './made-with-badge';

/**
 * A share page that shows no video: locked, expired, unavailable, unknown or
 * failed. One readable card, centred, with the badge under it.
 */
export function ShareNotice({
  title,
  body,
  children,
}: {
  title: string;
  body: string;
  children?: ReactNode;
}) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-4 sm:p-6">
      <Card pad="lg" className="w-full max-w-md">
        <h1 className="text-2xl font-semibold">{title}</h1>
        <p className="mt-2 text-ink-2">{body}</p>
        {children ? <div className="mt-4">{children}</div> : null}
      </Card>
      <MadeWithBadge />
    </main>
  );
}
