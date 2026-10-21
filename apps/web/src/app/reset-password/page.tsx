import { AuthCard } from '@/components/auth/auth-card';
import {
  InvalidResetLink,
  ResetPasswordForm,
} from '@/components/auth/reset-password-form';
import { t } from '@/i18n';

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string | string[] }>;
}) {
  const { token } = await searchParams;
  return (
    <AuthCard title={t('auth.reset.title')}>
      {typeof token === 'string' && token ? (
        <ResetPasswordForm token={token} />
      ) : (
        <InvalidResetLink />
      )}
    </AuthCard>
  );
}
