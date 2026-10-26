import { Banner } from '@andrewbehma/glass-ui/banner';
import { Card } from '@andrewbehma/glass-ui/card';
import { ProjectList } from '@/components/projects/project-list';
import { t } from '@/i18n';
import { getMachines, getProjects } from './_data';

export default async function ProjectsPage() {
  const [projects, machines] = await Promise.all([
    getProjects(),
    getMachines(),
  ]);
  return (
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
  );
}
