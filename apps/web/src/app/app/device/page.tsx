import { Banner } from '@andrewbehma/glass-ui/banner';
import { Card } from '@andrewbehma/glass-ui/card';
import { PageHeader } from '@andrewbehma/glass-ui/page-header';
import { redirect } from 'next/navigation';
import { DeviceApproval } from '@/components/device/device-approval';
import { DeviceCodeForm } from '@/components/device/device-code-form';
import { t } from '@/i18n';
import { getDevice, getSessionUser } from '@/lib/session';
import { normalizeUserCode } from '@/lib/user-code';

// Approve or deny a machine that ran `demoflow login` (spec #135, Decision 6).
// `?code=ABCD-1234` comes from the link the CLI opens; without it the person
// types the code shown in their terminal. One decision on one screen (spec
// #375, Decision 3).
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
    // A single decision reads best narrower than the shell's column.
    <div className="flex w-full max-w-2xl flex-col gap-6">
      {request && typeof request === 'object' ? (
        <>
          {/* The shell's banner asks for verification; this says why it matters. */}
          <PageHeader
            title={t('device.approve.title')}
            description={
              user.emailVerified
                ? t('device.description')
                : t('device.verifyFirst')
            }
          />
          <Card pad="lg">
            <DeviceApproval request={request} canApprove={user.emailVerified} />
          </Card>
        </>
      ) : (
        <>
          <PageHeader
            title={
              request === 'not_found'
                ? t('device.notFound.title')
                : t('device.code.title')
            }
            description={t('device.code.body')}
          />
          <Card pad="lg" className="flex flex-col gap-4">
            {request === 'not_found' ? (
              <Banner tone="danger">{t('device.notFound.body')}</Banner>
            ) : request === 'error' ? (
              <Banner tone="danger">{t('device.unavailable')}</Banner>
            ) : null}
            <DeviceCodeForm />
          </Card>
        </>
      )}
    </div>
  );
}
