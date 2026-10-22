import { buttonClassName } from '@andrewbehma/glass-ui/button';
import { Card } from '@andrewbehma/glass-ui/card';
import type { ReactNode } from 'react';
import { t } from '@/i18n';
import { githubStartUrl } from '@/lib/api';
import { getProviders } from '@/lib/session';

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

/**
 * "Continue with GitHub", only while the API has GitHub credentials (spec
 * #126, Decision 5). A real link: the API redirects it on to GitHub.
 */
export async function ProviderSlot() {
  const { github } = await getProviders();
  if (!github) return null;
  return (
    <>
      <p className="flex items-center gap-3 text-xs text-ink-3">
        <span aria-hidden className="h-px flex-1 bg-current opacity-30" />
        {t('auth.github.or')}
        <span aria-hidden className="h-px flex-1 bg-current opacity-30" />
      </p>
      <a
        href={githubStartUrl('sign-in')}
        className={buttonClassName({ variant: 'glass', full: true })}
      >
        {t('auth.github.continue')}
      </a>
    </>
  );
}
