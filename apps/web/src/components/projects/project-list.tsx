'use client';

import { Banner } from '@andrewbehma/glass-ui/banner';
import { Button } from '@andrewbehma/glass-ui/button';
import { Card } from '@andrewbehma/glass-ui/card';
import { ConfirmDialog } from '@andrewbehma/glass-ui/confirm-dialog';
import { EmptyState } from '@andrewbehma/glass-ui/empty-state';
import { Input } from '@andrewbehma/glass-ui/field';
import { Plus } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { StatusIndicator } from '@/components/status/status-indicator';
import { t } from '@/i18n';
import { isProjectName } from '@/lib/add-project';
import {
  type ApiResult,
  deleteProject,
  type Project,
  type Runner,
  updateProject,
} from '@/lib/api';
import { formatDate } from '@/lib/format-date';
import { formatRelative } from '@/lib/format-relative';
import { lastRunStatus } from '@/lib/status';
import type { ErrorKey } from '@/lib/validation';
import { apiErrorKey } from '../auth/form-parts';
import { GithubMark } from '../auth/github-mark';
import { AddProjectDialog } from './add-project-dialog';
import { MachinePill } from './machine-pill';

type Failure = 'projects.errors.name' | 'projects.errors.notFound';

export function ProjectList({
  projects,
  machines,
}: {
  projects: Project[];
  machines: Runner[];
}) {
  const router = useRouter();
  const [renaming, setRenaming] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Project | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Failure | ErrorKey | undefined>();
  const [adding, setAdding] = useState(false);
  // Every open mounts a fresh dialog, so it never shows the last folder.
  const [addKey, setAddKey] = useState(0);

  function stop() {
    setRenaming(null);
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

  async function rename(project: Project, name: string) {
    if (!isProjectName(name)) {
      setError('projects.errors.name');
      return;
    }
    if (
      await run(
        () => updateProject(project.id, { name: name.trim() }),
        'projects.errors.name',
      )
    ) {
      setRenaming(null);
    }
  }

  async function remove(project: Project) {
    await run(() => deleteProject(project.id), 'projects.errors.notFound');
    setDeleting(null);
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-end">
        <Button
          type="button"
          onClick={() => {
            setAddKey((key) => key + 1);
            setAdding(true);
          }}
        >
          <Plus aria-hidden size={16} />
          {t('projects.add.action')}
        </Button>
      </div>
      {error ? <Banner tone="danger">{t(error)}</Banner> : null}
      {projects.length === 0 ? (
        <EmptyState
          title={t('projects.empty.title')}
          description={t('projects.empty.body')}
          action={
            <Link href="/docs" className="text-sm text-ink underline">
              {t('projects.empty.docs')}
            </Link>
          }
        />
      ) : (
        <Card pad="none">
          <ul aria-label={t('projects.title')} className="flex flex-col">
            {projects.map((project) => (
              <li
                key={project.id}
                className="flex flex-col gap-3 border-b border-line px-4 py-3 last:border-0 md:flex-row md:items-start md:justify-between"
              >
                <div className="flex min-w-0 flex-1 flex-col gap-3">
                  {renaming === project.id ? (
                    <RenameForm
                      project={project}
                      busy={busy}
                      onSave={(value) => rename(project, value)}
                      onCancel={stop}
                    />
                  ) : (
                    <ProjectSummary project={project} />
                  )}
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-2">
                  {project.githubUrl ? (
                    <a
                      href={project.githubUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label={t('projects.item.github', {
                        name: project.name,
                      })}
                      title={t('projects.item.github', { name: project.name })}
                      className="inline-flex size-8 items-center justify-center rounded-control text-ink-2 hover:bg-hover hover:text-ink"
                    >
                      <GithubMark />
                    </a>
                  ) : null}
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setRenaming(project.id);
                      setError(undefined);
                    }}
                  >
                    {t('projects.rename.action')}
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
        </Card>
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
      <AddProjectDialog
        key={addKey}
        open={adding}
        onOpenChange={setAdding}
        machines={machines}
        projects={projects}
      />
    </div>
  );
}

/** One project's row: its name, machine, last run and how many runs it has. */
function ProjectSummary({ project }: { project: Project }) {
  const { lastRun } = project;
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <Link
        href={`/app/projects/${encodeURIComponent(project.id)}`}
        className="break-words font-semibold text-ink underline-offset-2 hover:underline"
      >
        {project.name}
      </Link>
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-ink-2">
        {project.rootPath === null ? (
          <span>{t('projects.item.noFolder')}</span>
        ) : (
          <MachinePill machine={project.runner} />
        )}
        <StatusIndicator status={lastRunStatus(lastRun)} />
        {lastRun ? (
          <>
            <time
              dateTime={lastRun.startedAt}
              title={formatDate(lastRun.startedAt)}
              suppressHydrationWarning
            >
              {formatRelative(lastRun.startedAt, Date.now()) ??
                t('runPage.metadata.justNow')}
            </time>
            <span aria-hidden>·</span>
            <span>
              {project.runCount === 1
                ? t('projects.item.runCountOne')
                : t('projects.item.runCount', { count: project.runCount })}
            </span>
          </>
        ) : null}
      </p>
    </div>
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
