import { Banner } from '@andrewbehma/glass-ui/banner';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ResendButton } from '@/components/auth/resend-button';
import { SignOutButton } from '@/components/auth/sign-out-button';
import { MachinesSummary } from '@/components/dashboard/machines-summary';
import { RecentProjects } from '@/components/dashboard/recent-projects';
import { t } from '@/i18n';
import { getRunners, getSessionUser } from '@/lib/session';
import { getProjects } from './projects/_data';

export default async function AppPage() {
  const user = await getSessionUser();
  if (!user) redirect('/sign-in');
  const [projects, runners] = await Promise.all([getProjects(), getRunners()]);
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-4 p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <p className="min-w-0 break-words text-sm text-ink-2">
          {t('app.shell.signedInAs', { email: user.email })}
        </p>
        <div className="flex items-center gap-3">
          <Link href="/app/projects" className="text-sm text-ink underline">
            {t('projects.nav')}
          </Link>
          <Link href="/app/machines" className="text-sm text-ink underline">
            {t('app.shell.machines')}
          </Link>
          <Link href="/app/settings" className="text-sm text-ink underline">
            {t('app.shell.settings')}
          </Link>
          <SignOutButton />
        </div>
      </header>
      {user.emailVerified ? null : (
        <Banner tone="warn" title={t('app.shell.verifyTitle')}>
          <p className="break-words">
            {t('app.shell.verifyBody', { email: user.email })}
          </p>
          <div className="mt-3">
            <ResendButton
              label={t('app.shell.resend')}
              sentLabel={t('app.shell.resent')}
            />
          </div>
        </Banner>
      )}
      <h1 className="text-2xl font-semibold">{t('dashboard.title')}</h1>
      <RecentProjects projects={projects} />
      <MachinesSummary runners={runners} />
    </main>
  );
}
