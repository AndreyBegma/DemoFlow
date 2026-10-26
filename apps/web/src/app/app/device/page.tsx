import { Banner } from '@andrewbehma/glass-ui/banner';
import { Card } from '@andrewbehma/glass-ui/card';
import { redirect } from 'next/navigation';
import { DeviceApproval } from '@/components/device/device-approval';
import { DeviceCodeForm } from '@/components/device/device-code-form';
import { t } from '@/i18n';
import { getDevice, getSessionUser } from '@/lib/session';
import { normalizeUserCode } from '@/lib/user-code';

// Approve or deny a machine that ran `demoflow login` (spec #135, Decision 6).
// `?code=ABCD-1234` comes from the link the CLI opens; without it the person
// types the code shown in their terminal.
export default async function DevicePage({
  searchParams,
}: {
  searchParams: Promise<{ code?: string | string[] }>;
}) {
  const user = await getSessionUser();
  if (!user) redirect('/sign-in');
  const { code: rawCode } = await searchParams;
  const code = normalizeUserCode(rawCode);
  const request = code ? await getDevice(code) : undefined;

  return (
    // The shell's banner asks for verification; this card says why it matters.
    <Card pad="lg" className="w-full max-w-2xl">
      {request && typeof request === 'object' ? (
        <>
          <h1 className="text-2xl font-semibold">
            {t('device.approve.title')}
          </h1>
          {user.emailVerified ? null : (
            <p className="mt-2 text-sm text-ink-2">{t('device.verifyFirst')}</p>
          )}
          <div className="mt-4">
            <DeviceApproval request={request} canApprove={user.emailVerified} />
          </div>
        </>
      ) : (
        <>
          <h1 className="text-2xl font-semibold">
            {request === 'not_found'
              ? t('device.notFound.title')
              : t('device.code.title')}
          </h1>
          <div className="mt-4 flex flex-col gap-4">
            {request === 'not_found' ? (
              <p className="text-sm text-ink-2">{t('device.notFound.body')}</p>
            ) : request === 'error' ? (
              <Banner tone="danger">{t('device.unavailable')}</Banner>
            ) : (
              <p className="text-sm text-ink-2">{t('device.code.body')}</p>
            )}
            <DeviceCodeForm />
          </div>
        </>
      )}
    </Card>
  );
}
