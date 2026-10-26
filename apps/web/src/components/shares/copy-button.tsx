'use client';

import { Button } from '@andrewbehma/glass-ui/button';
import { useEffect, useState } from 'react';
import { t } from '@/i18n';

const RESET_MS = 2000;

/** Writes `value` to the clipboard and says so for two seconds. */
export function CopyButton({
  value,
  label = t('shares.copy'),
  size = 'sm',
  variant = 'glass',
}: {
  value: string;
  /** The accessible name, when "Copy" alone would not say what is copied. */
  label?: string;
  size?: 'sm' | 'md';
  variant?: 'glass' | 'ghost';
}) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');

  useEffect(() => {
    if (state === 'idle') return;
    const timer = setTimeout(() => setState('idle'), RESET_MS);
    return () => clearTimeout(timer);
  }, [state]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setState('copied');
    } catch {
      setState('failed');
    }
  }

  return (
    <Button
      type="button"
      size={size}
      variant={variant}
      aria-label={label}
      onClick={() => void copy()}
    >
      <span aria-live="polite">
        {state === 'copied'
          ? t('shares.copied')
          : state === 'failed'
            ? t('shares.copyFailed')
            : t('shares.copy')}
      </span>
    </Button>
  );
}
