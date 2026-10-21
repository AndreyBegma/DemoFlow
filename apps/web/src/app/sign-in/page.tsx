import { Banner } from '@andrewbehma/glass-ui/banner';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { AuthCard, ProviderSlot } from '@/components/auth/auth-card';
import { SignInForm } from '@/components/auth/sign-in-form';
import { t } from '@/i18n';
import { githubErrorMessage } from '@/lib/github-errors';
import { safeReturnTo } from '@/lib/return-to';
import { getSessionUser } from '@/lib/session';

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{
    error?: string | string[];
    next?: string | string[];
  }>;
}) {
  const params = await searchParams;
  const next = safeReturnTo(params.next);
  if (await getSessionUser()) redirect(next ?? '/app');
  // A failed GitHub sign-in comes back here with `?error=<code>`.
  const githubError = githubErrorMessage(params.error);
  return (
    <AuthCard
      title={t('auth.signIn.title')}
      footer={
        <>
          <p>
            <Link href="/forgot-password" className="text-ink underline">
              {t('auth.signIn.forgot')}
            </Link>
          </p>
          <p>
            {t('auth.signIn.noAccount')}{' '}
            <Link href="/sign-up" className="text-ink underline">
              {t('auth.signIn.signUpLink')}
            </Link>
          </p>
        </>
      }
    >
      {githubError ? <Banner tone="danger">{githubError}</Banner> : null}
      <SignInForm next={next} />
      <ProviderSlot />
    </AuthCard>
  );
}
