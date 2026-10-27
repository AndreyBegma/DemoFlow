import type { Metadata } from 'next';
import { t } from '@/i18n';
import { THEME_BOOTSTRAP_SCRIPT } from '@/lib/theme';
import './globals.css';

export const metadata: Metadata = {
  title: t('meta.title'),
  description: t('app.tagline'),
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Glass UI reads its appearance from attributes on <html>. The theme ones
  // are set by the inline script before first paint (spec #373, Decision 6),
  // so the server's markup differs from the client's on purpose.
  return (
    <html lang="en" data-scale="desk" suppressHydrationWarning>
      <head>
        <script
          // biome-ignore lint/security/noDangerouslySetInnerHtml: a constant, bundled script
          dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP_SCRIPT }}
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
