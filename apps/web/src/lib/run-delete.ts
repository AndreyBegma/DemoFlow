// What the run page does with the answer of `DELETE /runs/:id` (spec #281). No
// React, no Node APIs, so `node --test` runs it as it is.

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
