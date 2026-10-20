import { Card } from '@andrewbehma/glass-ui/card';
import { t } from '@/i18n';

export default function HomePage() {
  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <Card className="max-w-md">
        <h1 className="text-2xl font-semibold">{t('home.title')}</h1>
        <p className="mt-2 text-sm opacity-70">{t('app.tagline')}</p>
      </Card>
    </main>
  );
}
