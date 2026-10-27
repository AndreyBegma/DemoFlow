import { buttonClassName } from '@andrewbehma/glass-ui/button';
import { Card } from '@andrewbehma/glass-ui/card';
import { Bot, Laptop, ShieldCheck } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { CopyInstall } from '@/components/landing/copy-install';
import { DemoVideo } from '@/components/landing/demo-video';
import { AccountDeletedNotice } from '@/components/settings/account-deleted-notice';
import { SiteHeader } from '@/components/site-header';
import { t } from '@/i18n';
import { getSessionUser } from '@/lib/session';

const REPO_URL = 'https://github.com/AndreyBegma/DemoFlow';
const NPM_URL = 'https://www.npmjs.com/package/demoflow';

const BENEFITS = [
  {
    icon: Bot,
    title: t('landing.benefits.write.title'),
    body: t('landing.benefits.write.body'),
  },
  {
    icon: ShieldCheck,
    title: t('landing.benefits.secrets.title'),
    body: t('landing.benefits.secrets.body'),
  },
  {
    icon: Laptop,
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
    <div className="relative isolate overflow-x-clip">
      {/* A soft accent glow behind the hero, from tokens so it works in both
          themes (spec #376, Decision 4); it also gives the glass something
          to blur. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[40rem] bg-[radial-gradient(60%_50%_at_50%_0%,var(--color-accent-soft),transparent)]"
      />
      <SiteHeader signedIn={Boolean(user)} />
      <main className="mx-auto flex max-w-5xl flex-col gap-20 px-4 pb-20 pt-10 sm:px-6 sm:pt-20">
        <AccountDeletedNotice />
        <section className="flex flex-col items-center gap-6 text-center">
          <p className="rounded-full border border-line bg-raised px-3 py-1 text-xs font-medium text-ink-2">
            {t('landing.hero.eyebrow')}
          </p>
          <h1 className="max-w-3xl text-balance text-3xl font-semibold tracking-tight sm:text-5xl">
            {t('landing.hero.title')}
          </h1>
          <p className="max-w-2xl text-pretty text-base text-ink-2 sm:text-lg">
            {t('landing.hero.subtitle')}
          </p>
          <div className="flex w-full max-w-md flex-col gap-3 text-left sm:flex-row sm:items-start">
            <Link
              href="/app"
              className={`${buttonClassName({ variant: 'solid' })} shrink-0 sm:h-[3.625rem]`}
            >
              {t('landing.hero.openApp')}
            </Link>
            <div className="min-w-0 flex-1">
              <CopyInstall />
            </div>
          </div>
        </section>
        <section className="flex flex-col gap-4">
          {/* Glass is the frame only; the video stays a solid black surface. */}
          <div className="glass rounded-surface p-2 shadow-2xl sm:p-3">
            <DemoVideo />
          </div>
          <p className="text-center text-sm text-ink-2">
            {t('landing.video.caption')}
          </p>
        </section>
        <section
          aria-labelledby="benefits-title"
          className="flex flex-col gap-6"
        >
          <h2
            id="benefits-title"
            className="text-2xl font-semibold tracking-tight"
          >
            {t('landing.benefits.title')}
          </h2>
          <div className="grid gap-4 md:grid-cols-3">
            {BENEFITS.map(({ icon: Icon, title, body }) => (
              <Card
                key={title}
                variant="glass"
                pad="lg"
                className="flex flex-col gap-3"
              >
                <span className="inline-flex size-10 items-center justify-center rounded-control bg-accent-soft text-accent-ink">
                  <Icon aria-hidden="true" className="size-5" />
                </span>
                <h3 className="text-lg font-semibold">{title}</h3>
                <p className="text-sm leading-6 text-ink-2">{body}</p>
              </Card>
            ))}
          </div>
        </section>
        <section aria-labelledby="install-title">
          <Card pad="lg" className="mx-auto flex max-w-xl flex-col gap-4">
            <h2
              id="install-title"
              className="text-2xl font-semibold tracking-tight"
            >
              {t('landing.install.title')}
            </h2>
            <p className="text-ink-2">{t('landing.install.body')}</p>
            <Link
              href="/docs"
              className={`${buttonClassName({ variant: 'ghost' })} self-start`}
            >
              {t('landing.install.readDocs')}
            </Link>
          </Card>
        </section>
      </main>
      <footer className="border-t border-line px-4 py-8 text-sm text-ink-2 sm:px-6">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-4">
          <p>{t('landing.footer.license')}</p>
          <nav
            aria-label={t('landing.footer.label')}
            className="flex flex-wrap gap-5"
          >
            <Link href="/docs" className="hover:text-ink">
              {t('landing.footer.docs')}
            </Link>
            <a href={REPO_URL} className="hover:text-ink">
              {t('landing.footer.github')}
            </a>
            <a href={NPM_URL} className="hover:text-ink">
              {t('landing.footer.npm')}
            </a>
          </nav>
        </div>
      </footer>
    </div>
  );
}
