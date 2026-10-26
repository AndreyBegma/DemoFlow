import { Banner } from '@andrewbehma/glass-ui/banner';
import { buttonClassName } from '@andrewbehma/glass-ui/button';
import { Card } from '@andrewbehma/glass-ui/card';
import { redirect } from 'next/navigation';
import { UnlinkGithubButton } from '@/components/auth/unlink-github-button';
import { DeleteAccount } from '@/components/settings/delete-account';
import { t } from '@/i18n';
import { githubStartUrl } from '@/lib/api';
import { githubErrorMessage } from '@/lib/github-errors';
import { getProviders, getSessionUser } from '@/lib/session';

// Account settings: linking and unlinking GitHub (spec #126, Decision 1), and
// deleting the account (spec #177). A failed link comes back here with
// `?error=<code>`.
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
    <div className="flex w-full max-w-2xl flex-col gap-6">
      {error ? <Banner tone="danger">{error}</Banner> : null}
      <Card pad="lg">
        <h1 className="text-2xl font-semibold">{t('app.settings.title')}</h1>
        <dl className="mt-6 flex flex-col gap-6">
          <div className="flex flex-col gap-1">
            <dt className="text-sm text-ink-2">{t('app.settings.email')}</dt>
            <dd className="min-w-0 break-words">{user.email}</dd>
          </div>
          <div className="flex flex-col gap-3">
            <dt className="text-sm text-ink-2">
              {t('app.settings.github.title')}
            </dt>
            <dd className="flex flex-col gap-3">
              <p>
                {user.githubLinked
                  ? t('app.settings.github.linked')
                  : t('app.settings.github.notLinked')}
              </p>
              {user.githubLinked ? (
                <UnlinkGithubButton hasPassword={user.hasPassword} />
              ) : github ? (
                <div>
                  <a
                    href={githubStartUrl('link')}
                    className={buttonClassName({ variant: 'solid' })}
                  >
                    {t('app.settings.github.link')}
                  </a>
                </div>
              ) : (
                <p className="text-sm text-ink-2">
                  {t('app.settings.github.unavailable')}
                </p>
              )}
            </dd>
          </div>
        </dl>
      </Card>
      <DeleteAccount email={user.email} />
    </div>
  );
}
