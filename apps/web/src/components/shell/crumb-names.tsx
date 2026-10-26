'use client';

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useState,
} from 'react';
import type { CrumbNames } from '@/lib/crumbs';

type Register = (segment: string, name: string) => () => void;

const RegisterContext = createContext<Register | null>(null);
const NamesContext = createContext<CrumbNames>(new Map());

/**
 * Holds the display names pages give their path segments (spec #373,
 * Decision 5), so the breadcrumb shows a project or run name, never its id.
 */
export function CrumbNamesProvider({ children }: { children: ReactNode }) {
  const [names, setNames] = useState<CrumbNames>(() => new Map());
  const register = useCallback<Register>((segment, name) => {
    setNames((current) => new Map(current).set(segment, name));
    return () =>
      setNames((current) => {
        if (current.get(segment) !== name) return current;
        const next = new Map(current);
        next.delete(segment);
        return next;
      });
  }, []);
  return (
    <RegisterContext.Provider value={register}>
      <NamesContext.Provider value={names}>{children}</NamesContext.Provider>
    </RegisterContext.Provider>
  );
}

/** The names registered so far, keyed by segment. */
export function useCrumbNames(): CrumbNames {
  return useContext(NamesContext);
}

/** Names `segment` in the breadcrumb while the calling component is mounted. */
export function useCrumbName(segment: string, name: string): void {
  const register = useContext(RegisterContext);
  useEffect(() => register?.(segment, name), [register, segment, name]);
}

/** `useCrumbName` for a server page: renders nothing. */
export function CrumbName({
  segment,
  name,
}: {
  segment: string;
  name: string;
}) {
  useCrumbName(segment, name);
  return null;
}
