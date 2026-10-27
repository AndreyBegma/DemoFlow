import { Badge } from '@andrewbehma/glass-ui/badge';
import { t } from '@/i18n';

/**
 * The stale mark (spec #363, Decision 2): "Stale" on a scenario, "N stale"
 * with `count` on a project. Nothing at a zero count — an absent badge is the
 * healthy state. The word carries the meaning, so it never depends on colour
 * alone.
 */
export function StaleBadge({ count }: { count?: number }) {
  if (count !== undefined && count <= 0) return null;
  return (
    <Badge
      tone="danger"
      size="md"
      label={
        count === undefined
          ? t('projects.stale.one')
          : t('projects.stale.count', { count })
      }
    />
  );
}
