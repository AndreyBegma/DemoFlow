import { Badge } from '@andrewbehma/glass-ui/badge';
import { StatusIndicator } from '@/components/status/status-indicator';
import { MACHINE_REMOVED } from '@/lib/status';

/**
 * The machine a project is bound to, as a pill; a removed machine is the
 * `unavailable` status, the same pill the run page shows for it.
 */
export function MachinePill({ machine }: { machine: { name: string } | null }) {
  return machine === null ? (
    <StatusIndicator status={MACHINE_REMOVED} />
  ) : (
    <Badge tone="neutral" size="md" label={machine.name} />
  );
}
