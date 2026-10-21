import Link from 'next/link';
import { redirect } from 'next/navigation';
import { AuthCard, ProviderSlot } from '@/components/auth/auth-card';
import { SignUpForm } from '@/components/auth/sign-up-form';
import { t } from '@/i18n';
import { getSessionUser } from '@/lib/session';

export default async function SignUpPage() {
  if (await getSessionUser()) redirect('/app');
  return (
    <AuthCard
      title={t('auth.signUp.title')}
      footer={
        <p>
          {t('auth.signUp.haveAccount')}{' '}
          <Link href="/sign-in" className="text-ink underline">
            {t('auth.signUp.signInLink')}
          </Link>
        </p>
      }
    >
      <SignUpForm />
      <ProviderSlot />
    </AuthCard>
  );
}
