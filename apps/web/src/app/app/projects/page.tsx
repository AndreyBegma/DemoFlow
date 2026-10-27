import { Banner } from '@andrewbehma/glass-ui/banner';
import { PageHeader } from '@andrewbehma/glass-ui/page-header';
import { ProjectList } from '@/components/projects/project-list';
import { t } from '@/i18n';
import { getMachines, getProjects } from './_data';

export default async function ProjectsPage() {
  const [projects, machines] = await Promise.all([
    getProjects(),
    getMachines(),
  ]);
  return (
    <>
      <PageHeader
        title={t('projects.title')}
        description={t('projects.description')}
      />
      {projects ? (
        <ProjectList projects={projects} machines={machines} />
      ) : (
        <Banner tone="danger">{t('projects.loadFailed')}</Banner>
      )}
    </>
  );
}
