'use client';

import { Banner } from '@andrewbehma/glass-ui/banner';
import { Button } from '@andrewbehma/glass-ui/button';
import { Card } from '@andrewbehma/glass-ui/card';
import { ConfirmDialog } from '@andrewbehma/glass-ui/confirm-dialog';
import { useEffect, useState } from 'react';
import { t } from '@/i18n';
import { useLaunch } from '@/lib/use-launch';
import { LaunchStatus } from './launch-status';

/**
 * "Run again" on the run page (spec #282): starts the run's own scenario on
 * the machine that recorded it, through the project's launch, with no options.
 * Only rendered when `canRunAgain` allows it.
 */
export function RunAgain({
  projectId,
  scenarioId,
  scenarioName,
  machineName,
  offline,
}: {
  projectId: string;
  scenarioId: string;
  scenarioName: string;
  machineName: string;
  offline: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  // A terminal launch found on mount is not this run's result; one that was
  // active here (started on this page or still going) is followed to its end.
  const [followed, setFollowed] = useState(false);
  const { launch, active, starting, cancelling, error, now, start, cancel } =
    useLaunch(projectId, true);

  useEffect(() => {
    if (active) setFollowed(true);
  }, [active]);

  async function confirmStart() {
    await start(scenarioId);
    setConfirming(false);
  }

  const showStatus = launch !== null && (active || followed);

  return (
    <Card pad="lg">
      <h2 className="text-lg font-semibold">{t('runPage.again.title')}</h2>
      <div className="mt-3 flex flex-col gap-3">
        {error ? <Banner tone="danger">{t(error)}</Banner> : null}
        {showStatus ? (
          <LaunchStatus
            projectId={projectId}
            launch={launch}
            now={now}
            cancelling={cancelling}
            onCancel={() => void cancel()}
            bordered={false}
          />
        ) : null}
        {active ? null : (
          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="button"
              variant="solid"
              disabled={offline || starting}
              onClick={() => setConfirming(true)}
            >
              {t('runPage.again.button')}
            </Button>
            {offline ? (
              <span className="text-sm text-ink-2">
                {t('runPage.again.offlineHint')}
              </span>
            ) : null}
          </div>
        )}
      </div>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        tone="default"
        title={t('projects.launch.confirm.title', {
          name: scenarioName,
          machine: machineName,
        })}
        consequence={t('projects.launch.confirm.body')}
        verb={t('projects.launch.confirm.verb')}
        cancelLabel={t('projects.launch.confirm.cancel')}
        busy={starting}
        onConfirm={() => void confirmStart()}
      />
    </Card>
  );
}
