'use client';

import { Banner } from '@andrewbehma/glass-ui/banner';
import { Button } from '@andrewbehma/glass-ui/button';
import { Card } from '@andrewbehma/glass-ui/card';
import { ConfirmDialog } from '@andrewbehma/glass-ui/confirm-dialog';
import { EmptyState } from '@andrewbehma/glass-ui/empty-state';
import { Select } from '@andrewbehma/glass-ui/select';
import { Spinner } from '@andrewbehma/glass-ui/spinner';
import { useCallback, useEffect, useState } from 'react';
import { t } from '@/i18n';
import { listScenarios, type ScenarioList } from '@/lib/api';
import { launchErrorKey } from '@/lib/launch';
import { useLaunch } from '@/lib/use-launch';
import { LaunchStatus } from './launch-status';

/**
 * The "Run a scenario" card: pick a scenario of the project's machine, start
 * it, follow it and cancel it (spec #249). With no folder or no machine it
 * only says so and makes no request.
 */
export function StartRun({
  projectId,
  rootPath,
  machine,
}: {
  projectId: string;
  rootPath: string | null;
  machine: { name: string } | null;
}) {
  const enabled = rootPath !== null && machine !== null;
  const [list, setList] = useState<ScenarioList | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [selected, setSelected] = useState('');
  const [confirming, setConfirming] = useState(false);
  const {
    launch,
    active,
    starting,
    cancelling,
    error,
    setError,
    now,
    start,
    cancel,
  } = useLaunch(projectId, enabled);

  const loadScenarios = useCallback(async () => {
    setLoading(true);
    const result = await listScenarios(projectId);
    setLoading(false);
    if (!result.ok) {
      setError(launchErrorKey(result.code));
      return;
    }
    setError(undefined);
    setList(result.data);
    setSelected((current) =>
      result.data.scenarios.some((scenario) => scenario.id === current)
        ? current
        : (result.data.scenarios[0]?.id ?? ''),
    );
  }, [projectId, setError]);

  // On mount: the scenario list.
  useEffect(() => {
    if (enabled) void loadScenarios();
  }, [enabled, loadScenarios]);

  async function confirmStart() {
    await start(selected);
    setConfirming(false);
  }

  if (!enabled) {
    return (
      <Card pad="lg">
        <h2 className="text-lg font-semibold">{t('projects.launch.title')}</h2>
        <p className="mt-2 text-sm text-ink-2">
          {rootPath === null
            ? t('projects.launch.unbound')
            : t('projects.launch.removed')}
        </p>
      </Card>
    );
  }

  const scenarios = list?.scenarios ?? [];
  const chosen = scenarios.find((scenario) => scenario.id === selected);
  const locked = active || starting;

  return (
    <Card pad="lg">
      <h2 className="text-lg font-semibold">{t('projects.launch.title')}</h2>
      <div className="mt-3 flex flex-col gap-3">
        {error ? <Banner tone="danger">{t(error)}</Banner> : null}
        {loading && list === null ? (
          <Spinner size="sm" label={t('projects.launch.loading')} />
        ) : null}
        {list !== null && scenarios.length === 0 ? (
          <EmptyState title={t('projects.launch.empty')} />
        ) : null}
        {scenarios.length > 0 ? (
          <div className="flex flex-wrap items-center gap-2">
            <div className="min-w-0 flex-1 basis-64">
              <Select
                aria-label={t('projects.launch.scenario')}
                value={selected}
                disabled={locked}
                onChange={(event) => setSelected(event.target.value)}
              >
                {scenarios.map((scenario) => (
                  <option key={scenario.id} value={scenario.id}>
                    {scenario.name} · {scenario.id}
                  </option>
                ))}
              </Select>
            </div>
            <Button
              type="button"
              variant="solid"
              disabled={locked || !chosen}
              onClick={() => setConfirming(true)}
            >
              {t('projects.launch.run')}
            </Button>
          </div>
        ) : null}
        <div>
          <Button
            type="button"
            variant="glass"
            disabled={loading}
            onClick={() => void loadScenarios()}
          >
            {t('projects.launch.refresh')}
          </Button>
        </div>
        {list !== null && list.skipped > 0 ? (
          <p className="text-sm text-ink-2">
            {t('projects.launch.skipped', { count: list.skipped })}
          </p>
        ) : null}
        {list?.truncated ? (
          <p className="text-sm text-ink-2">{t('projects.launch.truncated')}</p>
        ) : null}
        {launch ? (
          <LaunchStatus
            projectId={projectId}
            launch={launch}
            now={now}
            cancelling={cancelling}
            onCancel={() => void cancel()}
          />
        ) : null}
      </div>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        tone="default"
        title={t('projects.launch.confirm.title', {
          name: chosen?.name ?? '',
          machine: machine?.name ?? '',
        })}
        consequence={t('projects.launch.confirm.body')}
        verb={t('projects.launch.confirm.verb')}
        cancelLabel={t('projects.launch.confirm.cancel')}
        busy={starting}
        onConfirm={() => void confirmStart()}
      />
    </Card>
  );
}
