'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { cancelLaunch, getLaunch, type LaunchView, startLaunch } from './api';
import { isActive, type LaunchErrorKey, launchErrorKey } from './launch';

const POLL_MS = 2000;

/**
 * The launch of one project, shared by the project page's card and the run
 * page's action (specs #249, #282): the launch found on mount, the 2 s poll
 * (stopped at a terminal state, on unmount and while the tab is hidden), the
 * elapsed clock, start and cancel, and the message of the last failure.
 */
export function useLaunch(projectId: string, enabled: boolean) {
  const router = useRouter();
  const [launch, setLaunch] = useState<LaunchView | null>(null);
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

  // On mount: the running launch (a reload keeps following it).
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void getLaunch(projectId).then((result) => {
      if (!cancelled && result.ok) apply(result.data.launch);
    });
    return () => {
      cancelled = true;
    };
  }, [enabled, projectId, apply]);

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

  /** Starts the scenario; true when the machine accepted it. */
  async function start(
    scenarioId: string,
    formats?: string[],
  ): Promise<boolean> {
    setStarting(true);
    setError(undefined);
    const result = await startLaunch(projectId, scenarioId, formats);
    setStarting(false);
    if (result.ok) {
      apply(result.data.launch);
    } else {
      setError(launchErrorKey(result.code));
    }
    return result.ok;
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

  return {
    launch,
    active,
    starting,
    cancelling,
    error,
    setError,
    now,
    start,
    cancel,
  };
}
