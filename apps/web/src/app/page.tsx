import { buttonClassName } from '@andrewbehma/glass-ui/button';
import { Card } from '@andrewbehma/glass-ui/card';
import type { Metadata } from 'next';
import Link from 'next/link';
import { CopyInstall } from '@/components/landing/copy-install';
import { DemoVideo } from '@/components/landing/demo-video';
import { AccountDeletedNotice } from '@/components/settings/account-deleted-notice';
import { t } from '@/i18n';
import { getSessionUser } from '@/lib/session';

const REPO_URL = 'https://github.com/AndreyBegma/DemoFlow';

const BENEFITS = [
  {
    title: t('landing.benefits.write.title'),
    body: t('landing.benefits.write.body'),
  },
  {
    title: t('landing.benefits.secrets.title'),
    body: t('landing.benefits.secrets.body'),
  },
  {
    title: t('landing.benefits.local.title'),
    body: t('landing.benefits.local.body'),
  },
];

export function generateMetadata(): Metadata {
  const url = process.env.WEB_URL ?? 'http://localhost:3670';
  return {
    metadataBase: new URL(url),
    title: t('landing.meta.title'),
    description: t('landing.meta.description'),
    openGraph: {
      type: 'website',
      url,
      title: t('landing.meta.title'),
      description: t('landing.meta.description'),
      images: [
        {
          url: '/demo/og.png',
          width: 1200,
          height: 630,
          alt: t('landing.meta.imageAlt'),
        },
      ],
    },
  };
}

export default async function LandingPage() {
  const user = await getSessionUser();
  return (
    <>
      <header className="sticky top-0 z-10 p-3">
        <div className="glass mx-auto flex max-w-5xl items-center justify-between rounded-surface px-4 py-2">
          <Link
            href="/"
            aria-label={t('landing.nav.home')}
            className="text-lg font-semibold"
          >
            {t('meta.title')}
          </Link>
          <nav
            aria-label={t('landing.nav.label')}
            className="flex items-center gap-2"
          >
            <Link
              href="/docs"
              className={buttonClassName({ variant: 'ghost', size: 'sm' })}
            >
              {t('landing.nav.docs')}
            </Link>
            <Link
              href={user ? '/app' : '/sign-in'}
              className={buttonClassName({ variant: 'solid', size: 'sm' })}
            >
              {user ? t('landing.nav.openApp') : t('landing.nav.signIn')}
            </Link>
          </nav>
        </div>
      </header>
      <main className="mx-auto flex max-w-5xl flex-col gap-16 px-4 pb-16 pt-8 sm:px-6 sm:pt-16">
        <AccountDeletedNotice />
        <section className="flex flex-col gap-4 text-center">
          <h1 className="mx-auto max-w-3xl text-balance text-3xl font-semibold sm:text-5xl">
            {t('landing.hero.title')}
          </h1>
          <p className="mx-auto max-w-2xl text-pretty text-base text-ink-2 sm:text-lg">
            {t('landing.hero.subtitle')}
          </p>
        </section>
        <section className="flex flex-col gap-3">
          <DemoVideo />
          <p className="text-center text-sm text-ink-2">
            {t('landing.video.caption')}
          </p>
        </section>
        <section
          aria-labelledby="benefits-title"
          className="flex flex-col gap-6"
        >
          <h2 id="benefits-title" className="text-2xl font-semibold">
            {t('landing.benefits.title')}
          </h2>
          <div className="grid gap-4 md:grid-cols-3">
            {BENEFITS.map((benefit) => (
              <Card
                key={benefit.title}
                pad="lg"
                className="flex flex-col gap-2"
              >
                <h3 className="text-lg font-semibold">{benefit.title}</h3>
                <p className="text-sm text-ink-2">{benefit.body}</p>
              </Card>
            ))}
          </div>
        </section>
        <section aria-labelledby="install-title">
          <Card pad="lg" className="mx-auto flex max-w-xl flex-col gap-4">
            <h2 id="install-title" className="text-2xl font-semibold">
              {t('landing.install.title')}
            </h2>
            <CopyInstall />
            <p className="text-sm text-ink-2">{t('landing.install.body')}</p>
          </Card>
        </section>
      </main>
      <footer className="border-t border-line px-4 py-6 text-sm text-ink-2">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3">
          <p>{t('landing.footer.license')}</p>
          <nav className="flex gap-4">
            <Link href="/docs" className="underline">
              {t('landing.footer.docs')}
            </Link>
            <a href={REPO_URL} className="underline">
              {t('landing.footer.github')}
            </a>
          </nav>
        </div>
      </footer>
    </>
  );
}
