// What the run page does with the answer of `DELETE /runs/:id` (spec #281). No
// React, no Node APIs, so `node --test` runs it as it is.

export const DELETE_RUNS_MAX = 100;

export type RunDeleteOutcome = 'gone' | 'error';

interface DeleteResult {
  ok: boolean;
  status?: number;
}

/**
 * 204 and 404 both mean the run is gone: a 404 is a run deleted in another tab
 * or by a bulk delete, which is the state the user asked for. Anything else,
 * a network failure included (no status), keeps the page and shows an error.
 */
export function runDeleteOutcome(result: DeleteResult): RunDeleteOutcome {
  if (result.ok || result.status === 404) return 'gone';
  return 'error';
}

export type BulkDeleteOutcome =
  | { kind: 'deleted'; alreadyGone: number }
  | { kind: 'notFound' }
  | { kind: 'error' };

interface BulkDeleteResult extends DeleteResult {
  data?: { deleted: number };
}

/**
 * Spec #286, Decision 8. A 200 drops every sent run from the table, and
 * `alreadyGone` is how many of them the server no longer had. A 404 is the
 * project itself gone; anything else, a network failure included, keeps the
 * selection so the user can retry.
 */
export function bulkDeleteOutcome(
  result: BulkDeleteResult,
  sent: number,
): BulkDeleteOutcome {
  if (result.ok && result.data) {
    return {
      kind: 'deleted',
      alreadyGone: Math.max(0, sent - result.data.deleted),
    };
  }
  if (result.status === 404) return { kind: 'notFound' };
  return { kind: 'error' };
}
