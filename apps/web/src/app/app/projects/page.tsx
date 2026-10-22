import { Banner } from '@andrewbehma/glass-ui/banner';
import { Card } from '@andrewbehma/glass-ui/card';
import Link from 'next/link';
import { ProjectList } from '@/components/projects/project-list';
import { t } from '@/i18n';
import { getMachines, getProjects } from './_data';

export default async function ProjectsPage() {
  const [projects, machines] = await Promise.all([
    getProjects(),
    getMachines(),
  ]);
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-4 p-6">
      <header>
        <Link href="/app" className="text-sm text-ink-2 underline">
          {t('projects.back')}
        </Link>
      </header>
      <Card pad="lg">
        <h1 className="text-2xl font-semibold">{t('projects.title')}</h1>
        <div className="mt-4">
          {projects ? (
            <ProjectList projects={projects} machines={machines} />
          ) : (
            <Banner tone="danger">{t('projects.loadFailed')}</Banner>
          )}
        </div>
      </Card>
    </main>
  );
}
