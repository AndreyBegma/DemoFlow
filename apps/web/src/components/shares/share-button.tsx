'use client';

import { Button } from '@andrewbehma/glass-ui/button';
import { Share2 } from 'lucide-react';
import { useState } from 'react';
import { t } from '@/i18n';
import type { RunDetail } from '@/lib/api';
import { orderFormats } from '@/lib/playback';
import { type ShareButtonState, shareButtonState } from '@/lib/shares';
import { ShareDialog } from './share-dialog';

function hint(state: ShareButtonState, machine: string): string | null {
  switch (state) {
    case 'ready':
      return null;
    case 'outdated':
      return t('shares.button.hints.outdated', { machine });
    default:
      return t(`shares.button.hints.${state}`);
  }
}

/**
 * "Share" in the run page's header (spec #350, Decision 1). Disabled, with the
 * reason beside it, while the run has no render, its files are deleted, or its
 * machine is gone, offline or too old to share.
 */
export function ShareButton({
  run,
  machine,
}: {
  run: Pick<
    RunDetail['run'],
    'id' | 'formats' | 'renders' | 'artifactsDeletedAt'
  >;
  machine: RunDetail['machine'];
}) {
  const [open, setOpen] = useState(false);
  const state = shareButtonState(run, machine);
  const reason = hint(state, machine?.name ?? '');
  const reasonId = `share-reason-${run.id}`;
  return (
    <div className="flex flex-wrap items-center justify-end gap-3">
      {reason ? (
        <span id={reasonId} className="text-sm text-ink-2">
          {reason}
        </span>
      ) : null}
      <Button
        type="button"
        variant="solid"
        disabled={state !== 'ready'}
        aria-describedby={reason ? reasonId : undefined}
        onClick={() => setOpen(true)}
      >
        <Share2 className="size-4" aria-hidden="true" />
        {t('shares.button.open')}
      </Button>
      <ShareDialog
        open={open}
        onOpenChange={setOpen}
        runId={run.id}
        formats={orderFormats(run.formats)}
        renders={run.renders}
      />
    </div>
  );
}
