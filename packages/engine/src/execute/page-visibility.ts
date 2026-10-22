/** Runs in the page: whether `element` is on screen, by the rule a masked field and a marked element share. */
export type Shown = (element: Element) => boolean;

/**
 * Runs in the page: Playwright's rule for a visible element — connected,
 * rendered, `visibility: visible`, a non-empty box (#18). An element scrolled
 * out of the viewport is still shown: it is on the page and may scroll back.
 */
export function shown(element: Element): boolean {
  if (!element.isConnected || !element.checkVisibility()) return false;
  if (getComputedStyle(element).visibility !== 'visible') return false;
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

/**
 * `script` with `shown` handed in as its second argument, for
 * `page.evaluate` and `addInitScript`: a function sent to the page is sent as
 * its source, so it cannot close over this module's `shown`. The rule is
 * therefore written once and composed into each script by source.
 */
export function withShown<A, R>(
  script: (input: A, shown: Shown) => R,
): (input: A) => R {
  // Built in Node, never in the page: the page's CSP does not apply to it.
  return new Function('input', `return (${script})(input, ${shown});`) as (
    input: A,
  ) => R;
}
