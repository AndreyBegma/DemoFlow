import { Field, Select } from '@andrewbehma/glass-ui/field';
import { StatusPill } from '@andrewbehma/glass-ui/status-pill';
import { StatusIndicator } from '@/components/status/status-indicator';
import { t } from '@/i18n';
import { machineChoice } from '@/lib/add-project';
import type { Runner } from '@/lib/api';
import { machineStatus } from '@/lib/status';

/**
 * The machine picker (spec #379, Decision 2): offline machines and machines
 * whose CLI cannot add projects are listed but cannot be chosen.
 */
export function MachineField({
  id,
  machines,
  value,
  disabled,
  onChange,
}: {
  id: string;
  machines: Runner[];
  value: string;
  disabled: boolean;
  onChange: (runnerId: string) => void;
}) {
  const chosen = machines.find((machine) => machine.id === value);
  const outdated = machines.some(
    (machine) => machineChoice(machine) === 'outdated',
  );
  return (
    <Field
      label={t('projects.add.machine')}
      hint={outdated ? t('projects.add.outdatedHint') : undefined}
      htmlFor={id}
    >
      <div className="flex items-center gap-2">
        <Select
          id={id}
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
          // Focus starts here (Decision 6).
          autoFocus
          className="min-w-0 flex-1"
        >
          <option value="">{t('projects.add.machinePlaceholder')}</option>
          {machines.map((machine) => {
            const choice = machineChoice(machine);
            return (
              <option
                key={machine.id}
                value={machine.id}
                disabled={choice !== 'ready'}
              >
                {choice === 'offline'
                  ? t('projects.add.optionOffline', { name: machine.name })
                  : choice === 'outdated'
                    ? t('projects.add.optionOutdated', { name: machine.name })
                    : machine.name}
              </option>
            );
          })}
        </Select>
        {chosen ? (
          machineChoice(chosen) === 'outdated' ? (
            <StatusPill status="paused" label={t('projects.add.outdated')} />
          ) : (
            <StatusIndicator status={machineStatus(chosen.online)} />
          )
        ) : null}
      </div>
    </Field>
  );
}
