import { StatusPill } from '@andrewbehma/glass-ui/status-pill';
import { t } from '@/i18n';
import { PILL_STATUS, type StatusView } from '@/lib/status';

/**
 * A status as a pill: the dot in the kind's tone and its text label, the same
 * on every page that shows the state (spec #374, Decision 2).
 */
export function StatusIndicator({
  status,
  size = 'sm',
  className,
}: {
  status: StatusView;
  size?: 'sm' | 'md';
  className?: string;
}) {
  return (
    <StatusPill
      status={PILL_STATUS[status.kind]}
      label={t(status.label)}
      size={size}
      className={className}
      data-status-kind={status.kind}
    />
  );
}
