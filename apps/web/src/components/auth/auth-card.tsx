import { Card } from '@andrewbehma/glass-ui/card';
import type { ReactNode } from 'react';

/** The one readable card every auth page sits in, centred like the home page. */
export function AuthCard({
  title,
  children,
  footer,
}: {
  title: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <Card pad="lg" className="w-full max-w-md">
        <h1 className="text-2xl font-semibold">{title}</h1>
        <div className="mt-4 flex flex-col gap-4">{children}</div>
        {footer ? (
          <div className="mt-6 flex flex-col gap-1 text-sm text-ink-2">
            {footer}
          </div>
        ) : null}
      </Card>
    </main>
  );
}

/** Slot for slice 3's "Continue with GitHub" button; renders nothing yet. */
export function ProviderSlot() {
  return null;
}
