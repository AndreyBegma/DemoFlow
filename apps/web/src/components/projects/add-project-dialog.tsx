'use client';

import { Banner } from '@andrewbehma/glass-ui/banner';
import { Button } from '@andrewbehma/glass-ui/button';
import { DialogContent, DialogRoot } from '@andrewbehma/glass-ui/dialog';
import { Field, Input } from '@andrewbehma/glass-ui/field';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useReducer, useRef, useState } from 'react';
import { t } from '@/i18n';
import {
  type AddProjectState,
  addProjectReducer,
  canAdd,
  canCreateConfig,
  createInspector,
  folderErrorKey,
  githubUrlValue,
  INITIAL_STATE,
  inspectionResult,
  isProjectName,
  machineChoice,
  pathPlaceholder,
  preselectMachine,
} from '@/lib/add-project';
import {
  initFolder,
  inspectFolder,
  type Project,
  type Runner,
  registerFolder,
} from '@/lib/api';
import { InspectionPanel } from './add-project/inspection-panel';
import { MachineField } from './add-project/machine-field';

const FORM_ID = 'add-project-form';

/** The folder the dialog asks about, numbered as the reducer numbers it. */
interface Target {
  seq: number;
  runnerId: string;
  path: string;
}

/**
 * Adds a project from a folder on one of the user's machines (spec #379). The
 * page remounts it on every open, so it always starts empty.
 */
export function AddProjectDialog({
  open,
  onOpenChange,
  machines,
  projects,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  machines: Runner[];
  projects: Project[];
}) {
  const router = useRouter();
  const machineId = useId();
  const pathId = useId();
  const nameId = useId();
  const githubId = useId();
  const [runnerId, setRunnerId] = useState(() =>
    preselectMachine(machines, projects),
  );
  const [path, setPath] = useState('');
  // Until typed, the name and the link follow what the machine found.
  const [name, setName] = useState<string | null>(null);
  const [githubUrl, setGithubUrl] = useState<string | null>(null);
  const [checked, setChecked] = useState(false);
  const [state, dispatch] = useReducer(addProjectReducer, INITIAL_STATE);
  const target = useRef<Target>({ seq: 0, runnerId, path: '' });
  const [inspector] = useState(() =>
    createInspector({
      inspect: async (seq) => {
        const { runnerId: id, path: folder } = target.current;
        if (target.current.seq !== seq) return;
        const result = await inspectFolder(id, folder);
        dispatch(
          result.ok
            ? { type: 'inspected', seq, inspection: result.data }
            : { type: 'inspect-failed', seq, error: folderErrorKey(result) },
        );
      },
    }),
  );
  useEffect(() => inspector.dispose, [inspector]);

  const machine = machines.find((item) => item.id === runnerId);
  const inspection = 'inspection' in state ? state.inspection : null;
  const nameValue = name ?? inspection?.name ?? '';
  const githubValue = githubUrl ?? inspection?.githubUrl ?? '';
  const nameValid = isProjectName(nameValue);
  const githubValid = githubUrlValue(githubValue).ok;
  const working =
    state.phase === 'initialising' || state.phase === 'registering';
  const showsAdd =
    state.phase === 'idle' ||
    state.phase === 'inspecting' ||
    state.phase === 'registering' ||
    canAdd(state);

  /** A new machine or path: a new folder to inspect once typing pauses. */
  function change(nextRunnerId: string, nextPath: string) {
    const folder = nextPath.trim();
    const chosen = machines.find((item) => item.id === nextRunnerId);
    const ready =
      chosen !== undefined &&
      machineChoice(chosen) === 'ready' &&
      folder !== '';
    const seq = target.current.seq + 1;
    target.current = { seq, runnerId: nextRunnerId, path: folder };
    setName(null);
    setGithubUrl(null);
    setChecked(false);
    dispatch({ type: 'changed', seq, ready });
    inspector.change(seq, ready);
  }

  async function createConfig() {
    if (!canCreateConfig(state)) return;
    const { seq, runnerId: id, path: folder } = target.current;
    dispatch({ type: 'init-started', seq });
    const result = await initFolder(id, folder);
    dispatch(
      result.ok
        ? {
            type: 'initialised',
            seq,
            created: result.data.created,
            inspection: result.data.inspection,
          }
        : { type: 'init-failed', seq, error: folderErrorKey(result) },
    );
  }

  async function register() {
    if (!canAdd(state)) return;
    setChecked(true);
    const link = githubUrlValue(githubValue);
    if (!nameValid || !link.ok) return;
    const { seq, runnerId: id, path: folder } = target.current;
    dispatch({ type: 'register-started', seq });
    const result = await registerFolder({
      runnerId: id,
      path: folder,
      name: nameValue.trim(),
      githubUrl: link.url,
    });
    if (!result.ok) {
      dispatch({
        type: 'register-failed',
        seq,
        error: folderErrorKey(result),
        existingId:
          result.code === 'project-exists' ? (result.projectId ?? null) : null,
      });
      return;
    }
    const { id: projectId } = result.data.project;
    dispatch({ type: 'registered', seq, projectId });
    router.push(`/app/projects/${encodeURIComponent(projectId)}`);
  }

  return (
    <DialogRoot
      open={open}
      onOpenChange={(next) => {
        // A request in flight is not hidden by closing over it.
        if (state.phase !== 'registering') onOpenChange(next);
      }}
    >
      <DialogContent
        title={t('projects.add.title')}
        description={t('projects.add.description')}
        footer={
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="glass"
              disabled={state.phase === 'registering'}
              onClick={() => onOpenChange(false)}
            >
              {t('projects.add.cancel')}
            </Button>
            {machines.length > 0 && showsAdd ? (
              <Button type="submit" form={FORM_ID} disabled={!canAdd(state)}>
                {state.phase === 'registering'
                  ? t('projects.add.submitting')
                  : t('projects.add.submit')}
              </Button>
            ) : null}
          </div>
        }
      >
        {machines.length === 0 ? (
          <Banner
            tone="info"
            action={
              <Link href="/app/machines" className="text-sm underline">
                {t('projects.add.machines')}
              </Link>
            }
          >
            {t('projects.add.noMachines')}
          </Banner>
        ) : (
          <form
            id={FORM_ID}
            className="flex flex-col gap-4"
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              // Enter runs the action the folder offers (Decision 6).
              if (canAdd(state)) void register();
              else if (canCreateConfig(state)) void createConfig();
            }}
          >
            {machines.every((item) => machineChoice(item) !== 'ready') ? (
              <Banner tone="warn">{t('projects.add.noReadyMachines')}</Banner>
            ) : null}
            <MachineField
              id={machineId}
              machines={machines}
              value={runnerId}
              disabled={working}
              onChange={(value) => {
                setRunnerId(value);
                change(value, path);
              }}
            />
            <Field
              label={t('projects.add.path')}
              hint={t('projects.add.pathHint')}
              htmlFor={pathId}
            >
              <Input
                id={pathId}
                value={path}
                placeholder={pathPlaceholder(machine?.os)}
                autoComplete="off"
                spellCheck={false}
                disabled={working}
                onChange={(event) => {
                  setPath(event.target.value);
                  change(runnerId, event.target.value);
                }}
              />
            </Field>
            <InspectionPanel state={state} onCreateConfig={createConfig} />
            {inspection && inspectionResult(inspection) === 'found' ? (
              <>
                <Field
                  label={t('projects.add.name')}
                  error={
                    checked && !nameValid
                      ? t('projects.errors.name')
                      : undefined
                  }
                  htmlFor={nameId}
                >
                  <Input
                    id={nameId}
                    value={nameValue}
                    disabled={working}
                    onChange={(event) => setName(event.target.value)}
                  />
                </Field>
                <Field
                  label={t('projects.add.githubUrl')}
                  hint={t('projects.add.githubUrlHint')}
                  error={
                    checked && !githubValid
                      ? t('projects.add.githubUrlInvalid')
                      : undefined
                  }
                  htmlFor={githubId}
                >
                  <Input
                    id={githubId}
                    type="url"
                    value={githubValue}
                    placeholder="https://github.com/owner/repo"
                    autoComplete="off"
                    spellCheck={false}
                    disabled={working}
                    onChange={(event) => setGithubUrl(event.target.value)}
                  />
                </Field>
              </>
            ) : null}
            <p role="status" aria-live="polite" className="sr-only">
              {announcement(state)}
            </p>
          </form>
        )}
      </DialogContent>
    </DialogRoot>
  );
}

/** What the status region reads out as the folder is looked at (Decision 6). */
function announcement(state: AddProjectState): string {
  switch (state.phase) {
    case 'idle':
    case 'done':
      return '';
    case 'inspecting':
      return t('projects.add.inspecting');
    case 'failed':
      return t(state.error);
    case 'initialising':
      return t('projects.add.creatingConfig');
    case 'registering':
      return t('projects.add.submitting');
  }
  if (state.error) return t(state.error);
  switch (inspectionResult(state.inspection)) {
    case 'found': {
      const count = state.inspection.scenarios.length;
      return `${t('projects.add.found')}. ${
        count === 1
          ? t('projects.add.scenarioCountOne')
          : t('projects.add.scenarioCount', { count })
      }`;
    }
    case 'no-config':
      return t('projects.add.noConfig');
    case 'config-invalid':
      return t('projects.add.configInvalid');
  }
}
