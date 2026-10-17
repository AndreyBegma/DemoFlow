import type { Scenario, Step } from '@demoflow/core';

/** Why a run cannot start. `message` is `<code> <detail>`, e.g. `missing-env FIXTURE_PASSWORD`. */
export interface ReadinessProblem {
  message: string;
  stepIndex?: number;
}

export type Readiness =
  | { ok: true; secrets: ReadonlyMap<number, string> }
  | { ok: false; problem: ReadinessProblem };

export interface ReadinessInput {
  baseUrl: string | undefined;
  allowedOrigins: readonly string[];
  env: Readonly<Record<string, string | undefined>>;
}

/**
 * The origin allowlist (ADR-0003 §6, ADR-0008). `about:` and Chromium's own
 * error page are not origins a page can reach the network through.
 */
export class OriginGuard {
  readonly #allowed: ReadonlySet<string>;

  constructor(allowedOrigins: readonly string[]) {
    this.#allowed = new Set(allowedOrigins.map((value) => originOf(value)));
  }

  /** Returns the offending origin, or `undefined` when the URL may be opened. */
  check(url: string): string | undefined {
    if (url.startsWith('about:') || url.startsWith('chrome-error:')) {
      return undefined;
    }
    const origin = originOf(url);
    return this.#allowed.has(origin) ? undefined : origin;
  }
}

function originOf(url: string): string {
  try {
    const origin = new URL(url).origin;
    // `data:` and other opaque URLs have the origin `null`: report the URL's scheme instead.
    return origin === 'null' ? `${new URL(url).protocol}` : origin;
  } catch {
    return url;
  }
}

export function originNotAllowed(origin: string): string {
  return `origin-not-allowed ${origin}`;
}

/** The absolute URL a `navigate` step opens. */
export function navigateUrl(
  step: Extract<Step, { action: 'navigate' }>,
  baseUrl: string | undefined,
): string | undefined {
  if (step.url !== undefined) return step.url;
  if (step.path === undefined || baseUrl === undefined) return undefined;
  return new URL(step.path, baseUrl).href;
}

/**
 * Everything checked before the browser starts: every origin the scenario
 * names is allowed, and every `valueFrom.env` is set. The first problem wins.
 */
export function checkReadiness(
  scenario: Scenario,
  input: ReadinessInput,
): Readiness {
  const guard = new OriginGuard(input.allowedOrigins);
  if (input.baseUrl !== undefined) {
    const origin = guard.check(input.baseUrl);
    if (origin !== undefined) {
      return { ok: false, problem: { message: originNotAllowed(origin) } };
    }
  }
  const secrets = new Map<number, string>();
  for (const [stepIndex, step] of scenario.steps.entries()) {
    if (step.action === 'navigate') {
      const url = navigateUrl(step, input.baseUrl);
      if (url === undefined) {
        return {
          ok: false,
          problem: { message: `missing-base-url ${step.path}`, stepIndex },
        };
      }
      const origin = guard.check(url);
      if (origin !== undefined) {
        return {
          ok: false,
          problem: { message: originNotAllowed(origin), stepIndex },
        };
      }
    }
    if (step.action === 'fill' && step.valueFrom !== undefined) {
      const name = step.valueFrom.env;
      const value = input.env[name];
      if (value === undefined || value === '') {
        return {
          ok: false,
          problem: { message: `missing-env ${name}`, stepIndex },
        };
      }
      secrets.set(stepIndex, value);
    }
  }
  return { ok: true, secrets };
}
