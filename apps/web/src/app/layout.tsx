import type { Metadata } from 'next';
import { t } from '@/i18n';
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
  // Glass UI reads its appearance from these attributes: a dark developer
  // tool at desk density until there is an appearance setting.
  return (
    <html lang="en" data-theme="dark" data-scale="desk">
      <body>{children}</body>
    </html>
  );
}
