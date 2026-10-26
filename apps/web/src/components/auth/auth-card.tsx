import { buttonClassName } from '@andrewbehma/glass-ui/button';
import { Card } from '@andrewbehma/glass-ui/card';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { Logo } from '@/components/brand/logo';
import { t } from '@/i18n';
import { githubStartUrl } from '@/lib/api';
import { getProviders } from '@/lib/session';
import { GithubMark } from './github-mark';

/**
 * The frame every auth page sits in (spec #375, Decision 1): the logo above a
 * glass card, on the theme's soft canvas gradient. Glass is the frame; the
 * fields inside keep their solid surface.
 */
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
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 px-4 py-10">
      <div className="canvas" aria-hidden="true" />
      <Link href="/" className="rounded-control px-2 py-1">
        <Logo size={28} />
      </Link>
      <Card variant="glass" pad="lg" className="w-full max-w-md">
        <h1 className="text-2xl font-semibold">{title}</h1>
        <div className="mt-6 flex flex-col gap-4">{children}</div>
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
        <GithubMark />
        {t('auth.github.continue')}
      </a>
    </>
  );
}
