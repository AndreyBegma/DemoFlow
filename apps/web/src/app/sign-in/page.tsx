import Link from 'next/link';
import { redirect } from 'next/navigation';
import { AuthCard, ProviderSlot } from '@/components/auth/auth-card';
import { SignInForm } from '@/components/auth/sign-in-form';
import { t } from '@/i18n';
import { getSessionUser } from '@/lib/session';

export default async function SignInPage() {
  if (await getSessionUser()) redirect('/app');
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
      <SignInForm />
      <ProviderSlot />
    </AuthCard>
  );
}
