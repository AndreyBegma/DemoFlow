import { StatusIndicator } from '@/components/status/status-indicator';
import type { ProjectRun } from '@/lib/api';
import { runStatus } from '@/lib/status';

export function RunStatus({ status }: { status: ProjectRun['status'] }) {
  return <StatusIndicator status={runStatus(status)} />;
}
