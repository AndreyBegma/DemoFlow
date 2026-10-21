import { AuthCard } from '@/components/auth/auth-card';
import { VerifyEmail } from '@/components/auth/verify-email';
import { t } from '@/i18n';
import { getSessionUser } from '@/lib/session';

export default async function VerifyEmailPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string | string[] }>;
}) {
  const { token } = await searchParams;
  const signedIn = (await getSessionUser()) !== null;
  return (
    <AuthCard title={t('auth.verify.title')}>
      <VerifyEmail
        token={typeof token === 'string' ? token : ''}
        signedIn={signedIn}
      />
    </AuthCard>
  );
}
