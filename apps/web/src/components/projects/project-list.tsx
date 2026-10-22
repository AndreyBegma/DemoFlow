'use client';

import { Banner } from '@andrewbehma/glass-ui/banner';
import { Button } from '@andrewbehma/glass-ui/button';
import { ConfirmDialog } from '@andrewbehma/glass-ui/confirm-dialog';
import { EmptyState } from '@andrewbehma/glass-ui/empty-state';
import { Field, Input, Select } from '@andrewbehma/glass-ui/field';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type FormEvent, useId, useState } from 'react';
import { t } from '@/i18n';
import {
  type ApiResult,
  createProject,
  deleteProject,
  type Project,
  type Runner,
  updateProject,
} from '@/lib/api';
import { formatDate } from '@/lib/format-date';
import type { ErrorKey } from '@/lib/validation';
import { apiErrorKey } from '../auth/form-parts';
import { RunStatus } from './run-status';

const NAME_MAX = 200;

type Failure =
  | 'projects.errors.name'
  | 'projects.errors.bind'
  | 'projects.errors.notFound';

type Editing = { id: string; mode: 'rename' | 'bind' };

export function ProjectList({
  projects,
  machines,
}: {
  projects: Project[];
  machines: Runner[];
}) {
  const router = useRouter();
  const [editing, setEditing] = useState<Editing | null>(null);
  const [deleting, setDeleting] = useState<Project | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Failure | ErrorKey | undefined>();

  function stop() {
    setEditing(null);
    setError(undefined);
  }

  /** Runs one call; a 404 means the project is gone, so the list refreshes. */
  async function run(
    call: () => Promise<ApiResult<unknown>>,
    invalid: Failure,
  ): Promise<boolean> {
    setBusy(true);
    setError(undefined);
    const result = await call();
    setBusy(false);
    if (result.ok) {
      router.refresh();
      return true;
    }
    if (result.status === 404) {
      setError('projects.errors.notFound');
      router.refresh();
    } else {
      setError(
        result.error === 'invalid' ? invalid : apiErrorKey(result.error),
      );
    }
    return false;
  }

  async function create(name: string): Promise<boolean> {
    const value = name.trim();
    if (value.length < 1 || [...value].length > NAME_MAX) {
      setError('projects.errors.name');
      return false;
    }
    return run(() => createProject(value), 'projects.errors.name');
  }

  async function rename(project: Project, name: string) {
    const value = name.trim();
    if (value.length < 1 || [...value].length > NAME_MAX) {
      setError('projects.errors.name');
      return;
    }
    if (
      await run(
        () => updateProject(project.id, { name: value }),
        'projects.errors.name',
      )
    ) {
      setEditing(null);
    }
  }

  async function bind(project: Project, runnerId: string, rootPath: string) {
    const path = rootPath.trim();
    if (!runnerId || path.length < 1) {
      setError('projects.errors.bind');
      return;
    }
    if (
      await run(
        () => updateProject(project.id, { runnerId, rootPath: path }),
        'projects.errors.bind',
      )
    ) {
      setEditing(null);
    }
  }

  async function remove(project: Project) {
    await run(() => deleteProject(project.id), 'projects.errors.notFound');
    setDeleting(null);
  }

  return (
    <div className="flex flex-col gap-4">
      {error ? <Banner tone="danger">{t(error)}</Banner> : null}
      <CreateForm busy={busy} onCreate={create} />
      {projects.length === 0 ? (
        <EmptyState
          title={t('projects.empty.title')}
          description={t('projects.empty.body')}
        />
      ) : (
        <ul className="flex flex-col">
          {projects.map((project) => (
            <li
              key={project.id}
              className="flex flex-col gap-3 border-t border-current/10 py-4"
            >
              {editing?.id === project.id && editing.mode === 'rename' ? (
                <RenameForm
                  project={project}
                  busy={busy}
                  onSave={(value) => rename(project, value)}
                  onCancel={stop}
                />
              ) : (
                <ProjectSummary project={project} />
              )}
              {editing?.id === project.id && editing.mode === 'bind' ? (
                <BindForm
                  project={project}
                  machines={machines}
                  busy={busy}
                  onBind={(runnerId, path) => bind(project, runnerId, path)}
                  onCancel={stop}
                />
              ) : null}
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="glass"
                  size="sm"
                  onClick={() => {
                    setEditing({ id: project.id, mode: 'rename' });
                    setError(undefined);
                  }}
                >
                  {t('projects.rename.action')}
                </Button>
                <Button
                  type="button"
                  variant="glass"
                  size="sm"
                  onClick={() => {
                    setEditing({ id: project.id, mode: 'bind' });
                    setError(undefined);
                  }}
                >
                  {t('projects.bind.action')}
                </Button>
                <Button
                  type="button"
                  variant="danger"
                  size="sm"
                  onClick={() => setDeleting(project)}
                >
                  {t('projects.delete.action')}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        title={t('projects.delete.title', { name: deleting?.name ?? '' })}
        consequence={t('projects.delete.body')}
        verb={t('projects.delete.action')}
        busy={busy}
        onConfirm={() => {
          if (deleting) void remove(deleting);
        }}
      />
    </div>
  );
}

function ProjectSummary({ project }: { project: Project }) {
  const { lastRun } = project;
  return (
    <div className="flex flex-col gap-1">
      <Link
        href={`/app/projects/${encodeURIComponent(project.id)}`}
        className="break-words text-lg font-semibold underline"
      >
        {project.name}
      </Link>
      <p className="break-all text-sm text-ink-2">
        {project.rootPath === null
          ? t('projects.item.noFolder')
          : `${t('projects.item.path')}: ${project.rootPath}`}
      </p>
      {project.rootPath !== null ? (
        <p className="break-words text-sm text-ink-2">
          {t('projects.item.machine')}:{' '}
          {project.runner?.name ?? t('projects.item.machineRemoved')}
        </p>
      ) : null}
      <p className="flex flex-wrap items-center gap-2 text-sm">
        {lastRun ? (
          <>
            <span className="text-ink-2">{t('projects.item.lastRun')}</span>
            <RunStatus status={lastRun.status} />
            <time dateTime={lastRun.startedAt}>
              {formatDate(lastRun.startedAt)}
            </time>
            <span className="text-ink-2">
              ·{' '}
              {project.runCount === 1
                ? t('projects.item.runCountOne')
                : t('projects.item.runCount', { count: project.runCount })}
            </span>
          </>
        ) : (
          <span className="text-ink-2">{t('projects.item.noRuns')}</span>
        )}
      </p>
    </div>
  );
}

function CreateForm({
  busy,
  onCreate,
}: {
  busy: boolean;
  onCreate: (name: string) => Promise<boolean>;
}) {
  const [value, setValue] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (await onCreate(value)) setValue('');
  }
  return (
    <form className="flex flex-wrap items-end gap-2" onSubmit={submit}>
      <div className="min-w-0 flex-1">
        <Input
          aria-label={t('projects.create.label')}
          placeholder={t('projects.create.placeholder')}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          required
        />
      </div>
      <Button type="submit" disabled={busy}>
        {busy ? t('projects.create.submitting') : t('projects.create.submit')}
      </Button>
    </form>
  );
}

function RenameForm({
  project,
  busy,
  onSave,
  onCancel,
}: {
  project: Project;
  busy: boolean;
  onSave: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(project.name);
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        onSave(value);
      }}
    >
      <Input
        aria-label={t('projects.rename.label')}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        autoFocus
        required
      />
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={busy}>
          {busy ? t('projects.rename.saving') : t('projects.rename.save')}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={onCancel}
        >
          {t('projects.rename.cancel')}
        </Button>
      </div>
    </form>
  );
}

function BindForm({
  project,
  machines,
  busy,
  onBind,
  onCancel,
}: {
  project: Project;
  machines: Runner[];
  busy: boolean;
  onBind: (runnerId: string, rootPath: string) => void;
  onCancel: () => void;
}) {
  const machineId = useId();
  const pathId = useId();
  const [runnerId, setRunnerId] = useState(project.runner?.id ?? '');
  const [path, setPath] = useState(project.rootPath ?? '');
  if (machines.length === 0) {
    return (
      <Banner tone="info">
        {t('projects.bind.noMachines')}{' '}
        <Link href="/app/machines" className="underline">
          {t('projects.bind.machines')}
        </Link>
      </Banner>
    );
  }
  return (
    <form
      className="flex flex-col gap-3 rounded-control bg-hover p-3"
      aria-label={t('projects.bind.title', { name: project.name })}
      onSubmit={(event) => {
        event.preventDefault();
        onBind(runnerId, path);
      }}
    >
      <Field label={t('projects.bind.machine')} htmlFor={machineId}>
        <Select
          id={machineId}
          value={runnerId}
          onChange={(event) => setRunnerId(event.target.value)}
          required
        >
          <option value="">{t('projects.bind.machinePlaceholder')}</option>
          {machines.map((machine) => (
            <option key={machine.id} value={machine.id}>
              {machine.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field
        label={t('projects.bind.path')}
        hint={t('projects.bind.pathHint')}
        htmlFor={pathId}
      >
        <Input
          id={pathId}
          value={path}
          onChange={(event) => setPath(event.target.value)}
          required
        />
      </Field>
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={busy}>
          {busy ? t('projects.bind.submitting') : t('projects.bind.submit')}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={onCancel}
        >
          {t('projects.bind.cancel')}
        </Button>
      </div>
    </form>
  );
}
