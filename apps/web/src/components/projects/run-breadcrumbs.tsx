'use client';

import { Breadcrumb } from '@andrewbehma/glass-ui/breadcrumb';
import Link from 'next/link';
import { t } from '@/i18n';

/** Projects › project › this run. A client component: `link` is a function. */
export function RunBreadcrumbs({
  projectId,
  projectName,
  runName,
}: {
  projectId: string;
  projectName: string;
  runName: string;
}) {
  return (
    <Breadcrumb
      aria-label={t('runPage.breadcrumbs.label')}
      overflowLabel={t('runPage.breadcrumbs.overflow')}
      link={({ href, className, children }) => (
        <Link href={href} className={className}>
          {children}
        </Link>
      )}
      items={[
        {
          id: 'projects',
          label: t('runPage.breadcrumbs.projects'),
          href: '/app/projects',
        },
        {
          id: 'project',
          label: projectName,
          href: `/app/projects/${encodeURIComponent(projectId)}`,
        },
        { id: 'run', label: runName },
      ]}
    />
  );
}
