'use client';

import { Banner } from '@andrewbehma/glass-ui/banner';
import { Button } from '@andrewbehma/glass-ui/button';
import { ConfirmDialog } from '@andrewbehma/glass-ui/confirm-dialog';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { t } from '@/i18n';
import { deleteRun } from '@/lib/api';
import { runDeleteOutcome } from '@/lib/run-delete';

/**
 * "Delete run" on the run page (spec #281): removes the run's row after a
 * confirmation that says its video files stay on the machine, then lands on
 * the project's library.
 */
export function DeleteRun({
  runId,
  projectId,
  filesRemain,
}: {
  runId: string;
  projectId: string;
  filesRemain: boolean;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  async function confirmDelete() {
    setBusy(true);
    setFailed(false);
    const result = await deleteRun(runId);
    if (runDeleteOutcome(result) === 'gone') {
      // Stay busy: the page is about to unmount. `replace`, so Back does not
      // return to a run that no longer exists.
      router.replace(`/app/projects/${projectId}`);
      router.refresh();
      return;
    }
    setBusy(false);
    setConfirming(false);
    setFailed(true);
  }

  return (
    <div className="mt-4 flex flex-col gap-3">
      {failed ? (
        <Banner tone="danger">{t('auth.errors.unknown')}</Banner>
      ) : null}
      <div className="flex justify-end">
        <Button
          type="button"
          variant="danger"
          onClick={() => setConfirming(true)}
        >
          {t('runPage.deleteRun.open')}
        </Button>
      </div>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t('runPage.deleteRun.title')}
        consequence={t(
          filesRemain
            ? 'runPage.deleteRun.consequenceFiles'
            : 'runPage.deleteRun.consequence',
        )}
        verb={t('runPage.deleteRun.confirm')}
        cancelLabel={t('runPage.deleteRun.cancel')}
        busy={busy}
        onConfirm={() => void confirmDelete()}
      />
    </div>
  );
}
