import { Badge } from '@andrewbehma/glass-ui/badge';
import { t } from '@/i18n';
import type { ProjectRun } from '@/lib/api';

export function RunStatus({ status }: { status: ProjectRun['status'] }) {
  return status === 'passed' ? (
    <Badge tone="ok" label={t('projects.status.passed')} />
  ) : (
    <Badge tone="danger" label={t('projects.status.failed')} />
  );
}
