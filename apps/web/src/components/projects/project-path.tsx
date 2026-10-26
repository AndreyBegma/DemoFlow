'use client';

import { Button } from '@andrewbehma/glass-ui/button';
import { Tooltip } from '@andrewbehma/glass-ui/tooltip';
import { Check, Copy } from 'lucide-react';
import { useState } from 'react';
import { t } from '@/i18n';

/**
 * A project's root folder in the page header: muted, truncated from the left
 * so the folder's own name stays in view, the full path in a tooltip, and a
 * button that copies it (spec #374, Decision 5).
 */
export function ProjectPath({ path }: { path: string }) {
  const [status, setStatus] = useState<'idle' | 'copied' | 'failed'>('idle');

  async function copy() {
    try {
      await navigator.clipboard.writeText(path);
      setStatus('copied');
    } catch {
      setStatus('failed');
    }
  }

  return (
    <span className="flex min-w-0 items-center gap-1">
      <Tooltip content={path}>
        <span
          // biome-ignore lint/a11y/noNoninteractiveTabindex: the tooltip opens on keyboard focus too, so its trigger takes focus
          tabIndex={0}
          className="min-w-0 truncate rounded-control font-mono text-sm text-ink-2 [direction:rtl]"
        >
          <bdi dir="ltr">{path}</bdi>
        </span>
      </Tooltip>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-label={t('projects.library.copyPath')}
        onClick={copy}
      >
        {status === 'copied' ? (
          <Check aria-hidden size={14} />
        ) : (
          <Copy aria-hidden size={14} />
        )}
      </Button>
      <span aria-live="polite" className="shrink-0 text-xs text-ink-2">
        {status === 'copied' ? t('projects.library.pathCopied') : null}
        {status === 'failed' ? t('projects.library.copyFailed') : null}
      </span>
    </span>
  );
}
