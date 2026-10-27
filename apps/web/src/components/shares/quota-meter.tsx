import { Progress } from '@andrewbehma/glass-ui/progress';
import { t } from '@/i18n';
import { formatBytes } from '@/lib/format-bytes';
import { quotaPreview, type ShareQuota } from '@/lib/shares';

/**
 * "`<used>` of `<limit>` used" (spec #350, Decision 2). With `addBytes` it
 * previews the quota with a new share, and says so when it would not fit.
 */
export function QuotaMeter({
  quota,
  addBytes = null,
}: {
  quota: Pick<ShareQuota, 'usedBytes' | 'limitBytes'>;
  addBytes?: number | null;
}) {
  const preview = quotaPreview(quota, addBytes);
  const used = formatBytes(preview.usedBytes);
  const limit = formatBytes(preview.limitBytes);
  const label =
    addBytes === null
      ? t('shares.quota.used', { used, limit })
      : t('shares.quota.preview', {
          used,
          limit,
          after: formatBytes(preview.afterBytes),
        });
  return (
    <Progress
      aria-label={t('shares.quota.label')}
      value={Math.min(preview.afterBytes, preview.limitBytes)}
      max={Math.max(preview.limitBytes, 1)}
      label={label}
      hint={preview.fits ? undefined : t('shares.quota.noSpace')}
      tone={preview.fits ? 'neutral' : 'danger'}
    />
  );
}
