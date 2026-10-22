import Link from 'next/link';
import { AuthCard } from '@/components/auth/auth-card';
import { ForgotPasswordForm } from '@/components/auth/forgot-password-form';
import { t } from '@/i18n';

export default function ForgotPasswordPage() {
  return (
    <AuthCard
      title={t('auth.forgot.title')}
      footer={
        <p>
          <Link href="/sign-in" className="text-ink underline">
            {t('auth.forgot.back')}
          </Link>
        </p>
      }
    >
      <ForgotPasswordForm />
    </AuthCard>
  );
}
