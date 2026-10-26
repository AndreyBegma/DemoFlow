import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';
import { cache } from 'react';
import { ShareNotice } from '@/components/share-page/share-notice';
import { ShareView } from '@/components/share-page/share-view';
import { UnlockForm } from '@/components/share-page/unlock-form';
import { t } from '@/i18n';
import { apiUrl } from '@/lib/session';
import { fetchSharePage, unfurlsVideo } from '@/lib/share-page';

// Every request carries the viewer's cookies to the API (an unlock opens a
// protected share), so nothing here is rendered ahead of time.
export const dynamic = 'force-dynamic';

const NOINDEX: Metadata['robots'] = { index: false, follow: false };

/**
 * One `GET /s/:token` per request: the metadata and the page share it, so a
 * page load counts one view (spec #348, Decision 7).
 */
const getShare = cache(async (token: string) => {
  const cookie = (await cookies()).toString();
  return {
    cookie,
    state: await fetchSharePage(token, { baseUrl: apiUrl(), cookie }),
  };
});

/**
 * Unfurl metadata (spec #351, Decision 5). A locked share says nothing of
 * itself (ADR-0019 §2); every state is `noindex`.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ token: string }>;
}): Promise<Metadata> {
  const { token } = await params;
  const { state, cookie } = await getShare(token);
  switch (state.kind) {
    case 'share': {
      const { share } = state;
      const description = share.description ?? undefined;
      return {
        title: share.title,
        description,
        robots: NOINDEX,
        openGraph: {
          title: share.title,
          description,
          type: 'video.other',
          images: [{ url: share.posterUrl }],
          videos: unfurlsVideo(share, cookie)
            ? [
                {
                  url: share.fileUrl,
                  type: 'video/mp4',
                  width: share.width ?? undefined,
                  height: share.height ?? undefined,
                },
              ]
            : undefined,
        },
        twitter: {
          card: 'summary_large_image',
          title: share.title,
          description,
          images: [share.posterUrl],
        },
      };
    }
    case 'expired':
      return { title: t('sharePage.expired.title'), robots: NOINDEX };
    case 'unavailable':
      return { title: t('sharePage.unavailable.title'), robots: NOINDEX };
    default:
      return {
        title: t('sharePage.meta.locked'),
        robots: NOINDEX,
        openGraph: { title: t('sharePage.meta.locked') },
      };
  }
}

/**
 * The page a share link opens, for a viewer with no account (spec #351). No
 * app header and no sign-in prompt; the badge is the way to the landing page.
 * Expired and unavailable links answer 200: an App Router page cannot set 410.
 */
export default async function SharePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const { state } = await getShare(token);
  if (state.kind === 'not-found') notFound();
  switch (state.kind) {
    case 'share':
      return (
        <main className="mx-auto w-full max-w-5xl p-4 sm:p-6 lg:py-10">
          <ShareView share={state.share} />
        </main>
      );
    case 'locked':
      return (
        <ShareNotice
          title={t('sharePage.locked.title')}
          body={t('sharePage.locked.body')}
        >
          <UnlockForm token={token} />
        </ShareNotice>
      );
    case 'expired':
      return (
        <ShareNotice
          title={t('sharePage.expired.title')}
          body={t('sharePage.expired.body')}
        />
      );
    case 'unavailable':
      return (
        <ShareNotice
          title={t('sharePage.unavailable.title')}
          body={t('sharePage.unavailable.body')}
        />
      );
    case 'error':
      return (
        <ShareNotice
          title={t('sharePage.failed.title')}
          body={t('sharePage.failed.body')}
        />
      );
  }
}
