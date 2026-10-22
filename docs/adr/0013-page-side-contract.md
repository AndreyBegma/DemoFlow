# ADR-0013: The page-side contract: `data-demoflow-mask` and `window.demoflow`

Status: accepted · Date: 2026-10-22 · Specs: [197](../specs/197-mask-attribute.md),
[198](../specs/198-ready-signal.md)

## Context

Phase 7 of the roadmap starts the optional SDK (vision §3.5). Its first two
items let the application under demonstration take part in a run:

- it marks elements that must be masked;
- it says when a state is ready.

Application code is written against both, so they are a public contract. They
are not internal to DemoFlow, and renaming one later breaks applications that
no DemoFlow release can fix. Vision §3.5 sets three conditions:

- the SDK stays optional;
- it transmits no application data;
- its API is defined only once the scenario format is validated, which it now
  is (Phases 1–6).

ADR-0003 §4 lists the scenario actions, and §5 says the renderer masks the
fields of `valueFrom` fills. Both are extended here, not rewritten.

## Decision

1. **No package is needed for either item.** The application uses:
   - an HTML attribute, `data-demoflow-mask`;
   - a global the engine defines, `window.demoflow`.

   A later npm package (roadmap Phase 7, item 3) may wrap the global. It does
   not replace it.
2. **`data-demoflow-mask` masks the element.** The attribute's presence is what
   counts, with any value or none. No value unmasks. The renderer blurs the
   element's border box whenever it is on screen in the main frame. The rule
   for "on screen" is the one used for masked fields (#18): rendered,
   `visibility: visible`, with a non-empty box. This extends ADR-0003 §5, and
   that section's other rule still holds: the raw source recording and
   `screenshot` step images are local and are **not** masked.
3. **`window.demoflow` exists only during a run.** The engine installs it on
   every document before the page's own scripts. Outside a run it is
   undefined, so applications call `window.demoflow?.ready(...)`. Its shape is
   versioned: `window.demoflow.version` is `1`, and adding a method does not
   change the version. Removing or changing one would, and needs a new ADR.
4. **`window.demoflow.ready(name)` marks a state of the current document as
   ready.**
   - A name is 1–64 characters of `A–Z a–z 0–9 . _ : -` and starts with a
     letter or a digit.
   - A signal lasts as long as its document. A document navigation starts
     with nothing ready, and a same-document navigation keeps the signals.
   - Scenarios wait for a signal with a new action, `waitForReady { name }`.
     This adds to the action list in ADR-0003 §4.
5. **The page side never breaks the page, and it transmits nothing.**
   `ready` returns `undefined` and never throws, whatever its argument. A
   malformed name is ignored. Signals and masked elements stay in the
   browser, or in the timeline on the user's machine. ADR-0008 is unchanged.
6. **Main frame and light DOM only.** Elements inside iframes or shadow roots
   are not seen, and `ready` called from an iframe does not count. A later ADR
   may widen this. Narrowing it would break applications, so it starts
   narrow.

## Consequences

- An application can mask a secret, such as an API key shown in settings,
  without a scenario step that names it. It needs one attribute.
- Waiting for "the data has loaded" no longer needs a locator guessed from the
  rendered result, or a fixed `wait`.
- Applications can tell they are being recorded (`window.demoflow` is
  defined). That is intended: a demo may hide what it should not show.
- The documentation must say plainly that the attribute masks the rendered
  video only, not the raw recording, and not iframes or shadow DOM.
