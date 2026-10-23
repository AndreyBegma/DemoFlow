'use client';

import { Banner } from '@andrewbehma/glass-ui/banner';
import { Button } from '@andrewbehma/glass-ui/button';
import { Card } from '@andrewbehma/glass-ui/card';
import { ConfirmDialog } from '@andrewbehma/glass-ui/confirm-dialog';
import { EmptyState } from '@andrewbehma/glass-ui/empty-state';
import { Select } from '@andrewbehma/glass-ui/select';
import { Spinner } from '@andrewbehma/glass-ui/spinner';
import { StatusPill } from '@andrewbehma/glass-ui/status-pill';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { t } from '@/i18n';
import {
  cancelLaunch,
  getLaunch,
  type LaunchState,
  type LaunchView,
  listScenarios,
  type ScenarioList,
  startLaunch,
} from '@/lib/api';
import {
  formatElapsed,
  isActive,
  type LaunchErrorKey,
  launchErrorKey,
} from '@/lib/launch';

const POLL_MS = 2000;

const PILL: Record<LaunchState, Parameters<typeof StatusPill>[0]['status']> = {
  starting: 'waiting',
  running: 'running',
  cancelling: 'paused',
  passed: 'done',
  failed: 'error',
  cancelled: 'idle',
  'timed-out': 'error',
  lost: 'blocked',
};

function stateLabel(state: LaunchState): string {
  switch (state) {
    case 'timed-out':
      return t('projects.launch.state.timedOut');
    case 'lost':
      return t('projects.launch.state.lostLabel');
    default:
      return t(`projects.launch.state.${state}`);
  }
}

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
  const router = useRouter();
  const enabled = rootPath !== null && machine !== null;
  const [list, setList] = useState<ScenarioList | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [launch, setLaunch] = useState<LaunchView | null>(null);
  const [selected, setSelected] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [starting, setStarting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<LaunchErrorKey | undefined>();
  const [now, setNow] = useState(() => Date.now());
  const wasActive = useRef(false);

  const active = launch !== null && isActive(launch.state);

  const apply = useCallback(
    (next: LaunchView | null) => {
      const nowActive = next !== null && isActive(next.state);
      if (wasActive.current && !nowActive) router.refresh();
      wasActive.current = nowActive;
      setLaunch(next);
    },
    [router],
  );

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
  }, [projectId]);

  // On mount: the running launch (a reload keeps following it) and the list.
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void getLaunch(projectId).then((result) => {
      if (!cancelled && result.ok) apply(result.data.launch);
    });
    void loadScenarios();
    return () => {
      cancelled = true;
    };
  }, [enabled, projectId, apply, loadScenarios]);

  // Poll while the launch is active, and not while the tab is hidden.
  useEffect(() => {
    if (!active) return;
    let timer: ReturnType<typeof setInterval> | undefined;
    const poll = async () => {
      const result = await getLaunch(projectId);
      if (result.ok) apply(result.data.launch);
    };
    const start = () => {
      if (timer === undefined) timer = setInterval(() => void poll(), POLL_MS);
    };
    const stop = () => {
      clearInterval(timer);
      timer = undefined;
    };
    const onVisibility = () => {
      if (document.hidden) {
        stop();
      } else {
        void poll();
        start();
      }
    };
    if (!document.hidden) start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [active, projectId, apply]);

  // The elapsed-time clock.
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);

  async function confirmStart() {
    setStarting(true);
    setError(undefined);
    const result = await startLaunch(projectId, selected);
    setStarting(false);
    setConfirming(false);
    if (result.ok) {
      apply(result.data.launch);
    } else {
      setError(launchErrorKey(result.code));
    }
  }

  async function cancel() {
    setCancelling(true);
    setError(undefined);
    const result = await cancelLaunch(projectId);
    if (result.ok) {
      apply(result.data.launch);
    } else if (result.code === 'not-running') {
      const latest = await getLaunch(projectId);
      if (latest.ok) apply(latest.data.launch);
    } else {
      setError(launchErrorKey(result.code));
    }
    setCancelling(false);
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
          <div className="flex flex-col gap-2 border-t border-line pt-3">
            <div className="flex flex-wrap items-center gap-3">
              <span className="min-w-0 break-words font-medium">
                {launch.scenarioName ?? launch.scenarioId}
              </span>
              <StatusPill
                status={PILL[launch.state]}
                label={stateLabel(launch.state)}
              />
              {active ? (
                <span className="text-sm text-ink-2">
                  {t('projects.launch.elapsed', {
                    time: formatElapsed(now - Date.parse(launch.startedAt)),
                  })}
                </span>
              ) : null}
              {launch.state === 'running' ? (
                <Button
                  type="button"
                  variant="danger"
                  disabled={cancelling}
                  onClick={() => void cancel()}
                >
                  {t('projects.launch.cancelRun')}
                </Button>
              ) : null}
            </div>
            {launch.state === 'lost' ? (
              <p className="text-sm text-ink-2">
                {t('projects.launch.state.lost')}
              </p>
            ) : null}
            {!active && launch.runId ? (
              <Link
                href={`/app/projects/${projectId}/runs/${launch.runId}`}
                className="text-sm underline"
              >
                {t('projects.launch.openRun')}
              </Link>
            ) : null}
            {!active &&
            !launch.runId &&
            (launch.state === 'passed' || launch.state === 'failed') ? (
              <p className="text-sm text-ink-2">
                {t('projects.launch.noReport')}
              </p>
            ) : null}
          </div>
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
