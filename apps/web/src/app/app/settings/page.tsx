import { Banner } from '@andrewbehma/glass-ui/banner';
import { buttonClassName } from '@andrewbehma/glass-ui/button';
import { Card } from '@andrewbehma/glass-ui/card';
import { PageHeader } from '@andrewbehma/glass-ui/page-header';
import { SectionHeader } from '@andrewbehma/glass-ui/section-header';
import { Separator } from '@andrewbehma/glass-ui/separator';
import { StatusPill } from '@andrewbehma/glass-ui/status-pill';
import { Palette } from 'lucide-react';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { UnlinkGithubButton } from '@/components/auth/unlink-github-button';
import { DeleteAccount } from '@/components/settings/delete-account';
import { t } from '@/i18n';
import { githubStartUrl } from '@/lib/api';
import { githubErrorMessage } from '@/lib/github-errors';
import { getProviders, getSessionUser } from '@/lib/session';

/** One titled section of the page (spec #375, Decision 5). */
function SettingsSection({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3">
      <SectionHeader headingId={id} title={title} description={description} />
      {children}
    </section>
  );
}

/** A labelled fact with its state under it and, optionally, its action. */
function SettingRow({
  label,
  children,
  action,
}: {
  label: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 tablet:flex-row tablet:items-start tablet:justify-between tablet:gap-6">
      <div className="flex min-w-0 flex-col gap-1">
        <h3 className="text-sm font-medium text-ink-2">{label}</h3>
        <div className="min-w-0 break-words">{children}</div>
      </div>
      {action ? <div className="shrink-0 tablet:max-w-64">{action}</div> : null}
    </div>
  );
}

// Account settings: the profile, linking and unlinking GitHub (spec #126,
// Decision 1), and deleting the account (spec #177). A failed link comes back
// here with `?error=<code>`.
export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string | string[] }>;
}) {
  const user = await getSessionUser();
  if (!user) redirect('/sign-in');
  const { github } = await getProviders();
  const error = githubErrorMessage((await searchParams).error);

  return (
    // Forms read best narrower than the shell's column.
    <div className="flex w-full max-w-2xl flex-col gap-8">
      <PageHeader
        title={t('app.settings.title')}
        description={t('app.settings.description')}
      />
      {error ? <Banner tone="danger">{error}</Banner> : null}

      <SettingsSection
        id="settings-profile"
        title={t('app.settings.profile.title')}
        description={t('app.settings.profile.description')}
      >
        <Card pad="lg" className="flex flex-col gap-5">
          <SettingRow label={t('app.settings.email')}>{user.email}</SettingRow>
          <SettingRow label={t('app.settings.profile.verification')}>
            <StatusPill
              status={user.emailVerified ? 'done' : 'waiting'}
              label={
                user.emailVerified
                  ? t('app.settings.profile.verified')
                  : t('app.settings.profile.unverified')
              }
            />
          </SettingRow>
        </Card>
        <p className="flex items-center gap-2 text-sm text-ink-2">
          <Palette size={16} aria-hidden="true" className="shrink-0" />
          {t('app.settings.theme')}
        </p>
      </SettingsSection>

      <SettingsSection
        id="settings-methods"
        title={t('app.settings.methods.title')}
        description={t('app.settings.methods.description')}
      >
        <Card pad="lg" className="flex flex-col gap-5">
          <SettingRow label={t('app.settings.password.title')}>
            {user.hasPassword
              ? t('app.settings.password.set')
              : t('app.settings.password.notSet')}
          </SettingRow>
          <Separator />
          <SettingRow
            label={t('app.settings.github.title')}
            action={
              user.githubLinked ? (
                <UnlinkGithubButton hasPassword={user.hasPassword} />
              ) : github ? (
                <a
                  href={githubStartUrl('link')}
                  className={buttonClassName({ variant: 'solid' })}
                >
                  {t('app.settings.github.link')}
                </a>
              ) : undefined
            }
          >
            {user.githubLinked
              ? t('app.settings.github.linked')
              : github
                ? t('app.settings.github.notLinked')
                : t('app.settings.github.unavailable')}
          </SettingRow>
        </Card>
      </SettingsSection>

      <SettingsSection
        id="settings-danger"
        title={t('app.settings.danger.title')}
        description={t('app.settings.danger.description')}
      >
        <DeleteAccount email={user.email} />
      </SettingsSection>
    </div>
  );
}
