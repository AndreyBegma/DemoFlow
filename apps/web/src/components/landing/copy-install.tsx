'use client';

import { Button } from '@andrewbehma/glass-ui/button';
import { Check, Copy } from 'lucide-react';
import { useState } from 'react';
import { t } from '@/i18n';

type Status = 'idle' | 'copied' | 'failed';

/** The install command in a code block, with a button that copies it. */
export function CopyInstall() {
  const command = t('landing.install.command');
  const [status, setStatus] = useState<Status>('idle');

  async function copy() {
    try {
      await navigator.clipboard.writeText(command);
      setStatus('copied');
    } catch {
      setStatus('failed');
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3 rounded-lg border border-line bg-raised px-4 py-3">
        <code className="overflow-x-auto font-mono text-base">{command}</code>
        <Button
          type="button"
          variant="glass"
          size="sm"
          aria-label={t('landing.install.copy')}
          onClick={copy}
        >
          {status === 'copied' ? (
            <Check aria-hidden size={16} />
          ) : (
            <Copy aria-hidden size={16} />
          )}
        </Button>
      </div>
      <p aria-live="polite" className="min-h-4 text-xs text-ink-2">
        {status === 'copied' ? t('landing.install.copied') : null}
        {status === 'failed' ? t('landing.install.copyFailed') : null}
      </p>
    </div>
  );
}
