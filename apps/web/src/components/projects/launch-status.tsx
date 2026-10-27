'use client';

import { Button } from '@andrewbehma/glass-ui/button';
import { Progress } from '@andrewbehma/glass-ui/progress';
import Link from 'next/link';
import { StatusIndicator } from '@/components/status/status-indicator';
import { t } from '@/i18n';
import type { LaunchView } from '@/lib/api';
import { formatElapsed, isActive, launchProgress } from '@/lib/launch';
import { launchStatus } from '@/lib/status';
import { formatList } from './format-choice';

/** The row of a launch: name, state, elapsed time, cancel, and the new run. */
export function LaunchStatus({
  projectId,
  launch,
  now,
  cancelling,
  onCancel,
  bordered = true,
}: {
  projectId: string;
  launch: LaunchView;
  now: number;
  cancelling: boolean;
  onCancel: () => void;
  bordered?: boolean;
}) {
  const active = isActive(launch.state);
  const progress = launchProgress(launch);
  return (
    <div
      className={`flex flex-col gap-2 ${bordered ? 'border-t border-line pt-3' : ''}`}
    >
      <div className="flex flex-wrap items-center gap-3">
        <span className="min-w-0 break-words font-medium">
          {launch.scenarioName ?? launch.scenarioId}
        </span>
        <StatusIndicator status={launchStatus(launch.state)} />
        {active ? (
          <span className="text-sm text-ink-2">
            {t('projects.launch.elapsed', {
              time: formatElapsed(now - Date.parse(launch.startedAt)),
            })}
          </span>
        ) : null}
        {launch.state === 'running' ? (
          <Button
            type="button"
            variant="danger"
            disabled={cancelling}
            onClick={onCancel}
          >
            {t('projects.launch.cancelRun')}
          </Button>
        ) : null}
      </div>
      {launch.formats ? (
        <p className="text-sm text-ink-2">
          {t('projects.launch.formats.row', {
            list: formatList(launch.formats),
          })}
        </p>
      ) : null}
      {progress?.key === 'projects.launch.progress.steps' ? (
        <Progress
          value={progress.step}
          max={progress.steps}
          tone="neutral"
          label={t(progress.key, {
            step: progress.step,
            steps: progress.steps,
          })}
        />
      ) : progress ? (
        <p className="text-sm text-ink-2">{t(progress.key)}</p>
      ) : null}
      {launch.state === 'lost' ? (
        <p className="text-sm text-ink-2">{t('projects.launch.lost')}</p>
      ) : null}
      {!active && launch.runId ? (
        <Link
          href={`/app/projects/${projectId}/runs/${launch.runId}`}
          className="text-sm underline"
        >
          {t('projects.launch.openRun')}
        </Link>
      ) : null}
      {!active &&
      !launch.runId &&
      (launch.state === 'passed' || launch.state === 'failed') ? (
        <p className="text-sm text-ink-2">{t('projects.launch.noReport')}</p>
      ) : null}
    </div>
  );
}
