import { buttonClassName } from '@andrewbehma/glass-ui/button';
import Link from 'next/link';
import { Logo } from '@/components/brand/logo';
import { ThemeToggle } from '@/components/theme-toggle';
import { t } from '@/i18n';

/**
 * The floating glass header of the public site, shared by the landing page
 * and the docs (spec #376, Decision 1). `signedIn` picks "Open app" or
 * "Sign in"; a static page that reads no session leaves it out and gets
 * "Open app", which sends a signed-out visitor to sign in anyway.
 */
export function SiteHeader({
  signedIn,
  width = 'max-w-5xl',
}: {
  signedIn?: boolean;
  width?: 'max-w-5xl' | 'max-w-6xl';
}) {
  const showSignIn = signedIn === false;
  return (
    <header className="sticky top-0 z-chrome p-3">
      <div
        className={`glass mx-auto flex ${width} items-center justify-between gap-2 rounded-surface py-2 pl-4 pr-2`}
      >
        <Link
          href="/"
          aria-label={t('site.home')}
          className="rounded-control focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          <Logo />
        </Link>
        <nav aria-label={t('site.nav')} className="flex items-center gap-1">
          <Link
            href="/docs"
            className={buttonClassName({ variant: 'ghost', size: 'sm' })}
          >
            {t('site.docs')}
          </Link>
          <ThemeToggle />
          <Link
            href={showSignIn ? '/sign-in' : '/app'}
            className={buttonClassName({ variant: 'solid', size: 'sm' })}
          >
            {showSignIn ? t('site.signIn') : t('site.openApp')}
          </Link>
        </nav>
      </div>
    </header>
  );
}
