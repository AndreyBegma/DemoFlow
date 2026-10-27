'use client';

import { Banner } from '@andrewbehma/glass-ui/banner';
import { Button } from '@andrewbehma/glass-ui/button';
import { Card } from '@andrewbehma/glass-ui/card';
import { Checkbox } from '@andrewbehma/glass-ui/checkbox';
import { ConfirmDialog } from '@andrewbehma/glass-ui/confirm-dialog';
import { Field, Input, Select } from '@andrewbehma/glass-ui/field';
import { SectionHeader } from '@andrewbehma/glass-ui/section-header';
import {
  SegmentedControl,
  SegmentedControlItem,
} from '@andrewbehma/glass-ui/segmented-control';
import { Spinner } from '@andrewbehma/glass-ui/spinner';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type FormEvent, useEffect, useId, useState } from 'react';
import { t } from '@/i18n';
import {
  deleteSchedule,
  listScenarios,
  type ProjectSchedules,
  putSchedule,
  type ScenarioEntry,
  type CheckSchedule as Schedule,
} from '@/lib/api';
import { formatDate } from '@/lib/format-date';
import { formatRelative } from '@/lib/format-relative';
import {
  CADENCES,
  defaultZone,
  formatUntil,
  formError,
  formFor,
  pausedKey,
  type ScheduleErrorKey,
  type ScheduleForm,
  scheduleBody,
  scheduleErrorKey,
  toggleExclude,
  WEEKDAYS,
  type Weekday,
} from '@/lib/schedule';

type Machine = NonNullable<ProjectSchedules['machine']>;

type FormErrorKey =
  | 'projects.schedule.errors.time'
  | 'projects.schedule.errors.zone'
  | 'projects.schedule.errors.exclude';

/**
 * The "Scheduled checks" card of the project page (spec #363, Decision 1): the
 * website schedule with its form, or the config schedule read-only, and why a
 * schedule is paused.
 */
export function CheckSchedule({
  projectId,
  rootPath,
  schedules,
}: {
  projectId: string;
  rootPath: string | null;
  schedules: ProjectSchedules | null;
}) {
  const router = useRouter();
  const [site, setSite] = useState<Schedule | null>(schedules?.site ?? null);
  const [form, setForm] = useState<ScheduleForm | null>(null);
  const [error, setError] = useState<ScheduleErrorKey | undefined>();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const machine = schedules?.machine ?? null;
  const config = schedules?.config ?? null;

  function edit() {
    const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    setForm(formFor(site, defaultZone(machine?.zone, browserZone)));
    setError(undefined);
  }

  async function save(next: ScheduleForm) {
    setBusy(true);
    setError(undefined);
    const result = await putSchedule(projectId, scheduleBody(next));
    setBusy(false);
    if (!result.ok) {
      setError(scheduleErrorKey(result.status, result.code));
      if (result.status === 404 || result.status === 409) router.refresh();
      return;
    }
    setSite(result.data);
    setForm(null);
    router.refresh();
  }

  async function remove() {
    setBusy(true);
    setError(undefined);
    const result = await deleteSchedule(projectId);
    setBusy(false);
    setConfirming(false);
    if (!result.ok && result.status !== 404) {
      setError(scheduleErrorKey(result.status, result.code));
      return;
    }
    setSite(null);
    router.refresh();
  }

  return (
    <section aria-labelledby="check-schedule" className="flex flex-col gap-3">
      <SectionHeader
        title={t('projects.schedule.title')}
        headingId="check-schedule"
      />
      <Card pad="md" className="flex flex-col gap-3">
        {error ? <Banner tone="danger">{t(error)}</Banner> : null}
        {schedules === null ? (
          <p className="text-sm text-ink-2">
            {t('projects.schedule.loadFailed')}
          </p>
        ) : config !== null ? (
          <>
            <Summary schedule={config} machine={machine} />
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-ink-2">
              <span>{t('projects.schedule.fromConfig')}</span>
              <span aria-hidden>·</span>
              <Link
                href="/docs/checks"
                className="text-ink underline underline-offset-2"
              >
                {t('projects.schedule.docs')}
              </Link>
            </p>
          </>
        ) : form !== null && machine !== null ? (
          <EditForm
            projectId={projectId}
            machine={machine}
            initial={form}
            busy={busy}
            onSave={(next) => void save(next)}
            onCancel={() => {
              setForm(null);
              setError(undefined);
            }}
          />
        ) : site !== null ? (
          <>
            <Summary schedule={site} machine={machine} />
            <div className="flex flex-wrap gap-2">
              {machine !== null ? (
                <Button type="button" variant="glass" size="sm" onClick={edit}>
                  {t('projects.schedule.edit')}
                </Button>
              ) : null}
              <Button
                type="button"
                variant="danger"
                size="sm"
                disabled={busy}
                onClick={() => setConfirming(true)}
              >
                {t('projects.schedule.remove')}
              </Button>
            </div>
          </>
        ) : rootPath === null || machine === null ? (
          <p className="text-sm text-ink-2">{t('projects.schedule.unbound')}</p>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-ink-2">{t('projects.schedule.none')}</p>
            <Button type="button" variant="solid" size="sm" onClick={edit}>
              {t('projects.schedule.set')}
            </Button>
          </div>
        )}
      </Card>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t('projects.schedule.removeConfirm.title')}
        consequence={t('projects.schedule.removeConfirm.body')}
        verb={t('projects.schedule.removeConfirm.verb')}
        cancelLabel={t('projects.schedule.removeConfirm.cancel')}
        busy={busy}
        onConfirm={() => void remove()}
      />
    </section>
  );
}

function cadenceText(schedule: Schedule): string {
  if (schedule.cadence !== 'weekly') {
    return t(`projects.schedule.cadenceText.${schedule.cadence}`);
  }
  const day = (WEEKDAYS as readonly (string | null)[]).includes(
    schedule.weekday,
  )
    ? t(`projects.schedule.days.${schedule.weekday as Weekday}`)
    : '';
  return t('projects.schedule.cadenceText.weekly', { day });
}

/** "Checks every weekday at 09:30 (Europe/Berlin) on …", the next check and the last. */
function Summary({
  schedule,
  machine,
}: {
  schedule: Schedule;
  machine: Machine | null;
}) {
  const now = Date.now();
  const paused = pausedKey(schedule.pausedReason);
  const params = {
    cadence: cadenceText(schedule),
    at: schedule.at,
    zone: schedule.timeZone,
  };
  return (
    <div className="flex flex-col gap-2">
      {paused ? (
        <Banner tone="warn">
          {t(paused, { machine: machine?.name ?? '' })}
        </Banner>
      ) : null}
      <p className="font-medium text-ink">
        {machine
          ? t('projects.schedule.summary', { ...params, machine: machine.name })
          : t('projects.schedule.summaryNoMachine', params)}
      </p>
      <ul className="flex flex-col gap-1 text-sm text-ink-2">
        {paused ? null : machine !== null && !machine.online ? (
          <li>
            {t('projects.schedule.nextOffline', { machine: machine.name })}
          </li>
        ) : schedule.nextDueAt ? (
          <li>
            <time
              dateTime={schedule.nextDueAt}
              title={formatDate(schedule.nextDueAt)}
              suppressHydrationWarning
            >
              {(() => {
                const when = formatUntil(schedule.nextDueAt, now);
                return when
                  ? t('projects.schedule.next', { when })
                  : t('projects.schedule.nextSoon');
              })()}
            </time>
          </li>
        ) : null}
        <li>
          {schedule.lastPassAt ? (
            <time
              dateTime={schedule.lastPassAt}
              title={formatDate(schedule.lastPassAt)}
              suppressHydrationWarning
            >
              {(() => {
                const when = formatRelative(schedule.lastPassAt, now);
                return when
                  ? t('projects.schedule.lastPass', { when })
                  : t('projects.schedule.lastPassJustNow');
              })()}
            </time>
          ) : (
            t('projects.schedule.noPass')
          )}
        </li>
        {schedule.exclude.length > 0 ? (
          <li className="break-all">
            {t('projects.schedule.exclude.saved', {
              list: schedule.exclude.join(', '),
            })}
          </li>
        ) : null}
      </ul>
    </div>
  );
}

/** Every IANA zone the browser knows, with the current one kept first. */
function zoneOptions(current: string): string[] {
  const known =
    typeof Intl.supportedValuesOf === 'function'
      ? Intl.supportedValuesOf('timeZone')
      : [];
  return [current, ...known.filter((zone) => zone !== current)];
}

function EditForm({
  projectId,
  machine,
  initial,
  busy,
  onSave,
  onCancel,
}: {
  projectId: string;
  machine: Machine;
  initial: ScheduleForm;
  busy: boolean;
  onSave: (form: ScheduleForm) => void;
  onCancel: () => void;
}) {
  const weekdayId = useId();
  const atId = useId();
  const zoneId = useId();
  const [form, setForm] = useState(initial);
  const [invalid, setInvalid] = useState<FormErrorKey | undefined>();
  const [choosingZone, setChoosingZone] = useState(false);
  const [scenarios, setScenarios] = useState<ScenarioEntry[] | null>(null);
  const [scenariosFailed, setScenariosFailed] = useState(false);

  // The "Leave out" checklist needs the machine online (spec #363).
  useEffect(() => {
    if (!machine.online) return;
    let live = true;
    void listScenarios(projectId).then((result) => {
      if (!live) return;
      if (result.ok) setScenarios(result.data.scenarios);
      else setScenariosFailed(true);
    });
    return () => {
      live = false;
    };
  }, [projectId, machine.online]);

  function update(patch: Partial<ScheduleForm>) {
    setForm((current) => ({ ...current, ...patch }));
    setInvalid(undefined);
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const problem = formError(form);
    if (problem) {
      setInvalid(`projects.schedule.errors.${problem}`);
      return;
    }
    onSave(form);
  }

  // Saved ids the machine no longer lists stay visible, so they can be unticked.
  const known = new Set(scenarios?.map((scenario) => scenario.id));
  const checklist: ScenarioEntry[] = [
    ...(scenarios ?? []),
    ...form.exclude
      .filter((id) => !known.has(id))
      .map((id) => ({ id, name: id })),
  ];

  return (
    <form
      className="flex flex-col gap-4"
      aria-label={t('projects.schedule.title')}
      noValidate
      onSubmit={submit}
    >
      {invalid ? <Banner tone="danger">{t(invalid)}</Banner> : null}
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 text-sm font-medium text-ink">
          {t('projects.schedule.cadence.label')}
        </legend>
        <div className="max-w-full overflow-x-auto">
          <SegmentedControl
            aria-label={t('projects.schedule.cadence.label')}
            size="sm"
          >
            {CADENCES.map((cadence) => (
              <SegmentedControlItem
                key={cadence}
                active={cadence === form.cadence}
                layoutId="schedule-cadence"
              >
                <button
                  type="button"
                  aria-pressed={cadence === form.cadence}
                  className="whitespace-nowrap px-3 py-1 text-sm"
                  onClick={() => update({ cadence })}
                >
                  {t(`projects.schedule.cadence.${cadence}`)}
                </button>
              </SegmentedControlItem>
            ))}
          </SegmentedControl>
        </div>
      </fieldset>
      <div className="flex flex-wrap gap-3">
        {form.cadence === 'weekly' ? (
          <div className="min-w-40 flex-1">
            <Field label={t('projects.schedule.weekday')} htmlFor={weekdayId}>
              <Select
                id={weekdayId}
                value={form.weekday}
                onChange={(event) =>
                  update({ weekday: event.target.value as Weekday })
                }
              >
                {WEEKDAYS.map((day) => (
                  <option key={day} value={day}>
                    {t(`projects.schedule.days.${day}`)}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        ) : null}
        <div className="min-w-40 flex-1">
          <Field
            label={t('projects.schedule.at')}
            hint={t('projects.schedule.atHint')}
            htmlFor={atId}
            error={
              invalid === 'projects.schedule.errors.time'
                ? t(invalid)
                : undefined
            }
          >
            <Input
              id={atId}
              value={form.at}
              inputMode="numeric"
              placeholder="09:00"
              maxLength={5}
              aria-invalid={invalid === 'projects.schedule.errors.time'}
              onChange={(event) => update({ at: event.target.value.trim() })}
            />
          </Field>
        </div>
      </div>
      {choosingZone ? (
        <Field label={t('projects.schedule.zone')} htmlFor={zoneId}>
          <Select
            id={zoneId}
            value={form.timeZone}
            onChange={(event) => update({ timeZone: event.target.value })}
          >
            {zoneOptions(form.timeZone).map((zone) => (
              <option key={zone} value={zone}>
                {zone}
              </option>
            ))}
          </Select>
        </Field>
      ) : (
        <p className="flex flex-wrap items-center gap-2 text-sm text-ink-2">
          <span>
            {t('projects.schedule.zoneValue', { zone: form.timeZone })}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setChoosingZone(true)}
          >
            {t('projects.schedule.changeZone')}
          </Button>
        </p>
      )}
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium text-ink">
          {t('projects.schedule.exclude.label')}
        </legend>
        {!machine.online || scenariosFailed ? (
          <>
            <p className="text-sm text-ink-2">
              {t('projects.schedule.exclude.offline')}
            </p>
            {form.exclude.length > 0 ? (
              <p className="break-all text-sm text-ink-2">
                {t('projects.schedule.exclude.saved', {
                  list: form.exclude.join(', '),
                })}
              </p>
            ) : null}
          </>
        ) : scenarios === null ? (
          <Spinner size="sm" label={t('projects.schedule.exclude.loading')} />
        ) : checklist.length === 0 ? (
          <p className="text-sm text-ink-2">
            {t('projects.schedule.exclude.none')}
          </p>
        ) : (
          <>
            <p className="text-sm text-ink-2">
              {t('projects.schedule.exclude.hint')}
            </p>
            <ul className="flex max-h-64 flex-col gap-2 overflow-y-auto">
              {checklist.map((scenario) => (
                <li key={scenario.id}>
                  <Checkbox
                    label={scenario.name}
                    hint={
                      scenario.name === scenario.id ? undefined : scenario.id
                    }
                    aria-label={t('projects.schedule.exclude.scenario', {
                      name: scenario.name,
                    })}
                    checked={form.exclude.includes(scenario.id)}
                    onChange={(event) =>
                      update({
                        exclude: toggleExclude(
                          form.exclude,
                          scenario.id,
                          event.target.checked,
                        ),
                      })
                    }
                  />
                </li>
              ))}
            </ul>
          </>
        )}
      </fieldset>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={busy}>
          {busy ? t('projects.schedule.saving') : t('projects.schedule.save')}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={onCancel}
        >
          {t('projects.schedule.cancel')}
        </Button>
      </div>
    </form>
  );
}
