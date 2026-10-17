# Fixture app — a deterministic demo target

Issue: [#2](https://github.com/AndreyBegma/DemoFlow/issues/2) · Phase 1 ·
Decisions: [ADR-0001](../adr/0001-control-plane-execution-plane-one-package.md),
[ADR-0002](../adr/0002-develop-integration-staging-and-os-matrix.md)

## Summary

The engine, both renderers and the three-OS matrix need an application to
demonstrate that behaves the same on every run and every machine, works
offline, and exercises everything that is hard to film: hover states, a
modal, a form, a long scroll, a scrolling container, a loading spinner and a
password field. This item builds it as `apps/fixture`, a static Vite + React
site styled with Glass UI. It is never deployed.

## Scope

### In scope

- `apps/fixture` (`@demoflow/fixture`, private): Vite 7, React 19,
  Tailwind 4 (`@tailwindcss/vite`), `@andrewbehma/glass-ui` 0.34.0 with the
  same CSS imports as `apps/web`, `react-router` for routes.
- Scripts: `dev` and `preview` on port **3680** (`--strictPort`), `build` to
  `apps/fixture/dist`, `lint`.
- The pages below, with static, synthetic data.

### Out of scope

- Scenarios (`*.demo.json`) — the engine issue (#3) writes them against
  these pages.
- Any network request, persistence or real authentication.

## UI

Every interactive element has an accessible name; the elements marked
`testId` also carry `data-testid`.

| Route | Content | Must allow |
|---|---|---|
| `/` | title "DemoFlow Fixture", nav links to every page | `navigate`, `click` by role `link` |
| `/customers` | table of 20 fixed customers (name, email, plan); search field labelled "Search customers" filtering by name; button "New customer" | `fill`, `assertText`, `assertVisible` |
| `/customers` dialog | Glass UI dialog "New customer": fields "Name", "Email", select "Plan" (Free, Pro, Team), button "Create"; on submit a toast "Customer created" and a new first row | `select`, a modal, a toast |
| `/login` | fields "Email" and "Password" (type password), button "Sign in"; any email and a password of ≥ 8 characters "signs in" to a page "Welcome, <email>"; a shorter password shows "Password too short" | masked `fill` from env, a negative path |
| `/long` | 30 sections of fixed text with headings "Section 1"…"Section 30", button "Back to top" at the end; a side panel `testId: log-panel` that scrolls inside itself | `scroll` page and `scroll within` |
| `/slow` | button "Load report"; shows a spinner for 1 500 ms, then "Report ready" | the idle rule of ADR-0004 §5 (a spinner is not idle) |
| `/hover` | a card `testId: hover-card` that shows a tooltip "Details" on hover | `hover` |

Deterministic: no `Date.now()` or `Math.random()` in rendered output, fonts
bundled locally (no Google Fonts request), animations from Glass UI kept, and
`prefers-reduced-motion` respected.

## Acceptance criteria

- [ ] `bun run --filter @demoflow/fixture build` passes, and `bun run check`
      and `bun run build` pass at the root.
- [ ] `bun run --filter @demoflow/fixture preview` serves every route on
      http://localhost:3680, and a refresh on a deep route (`/customers`)
      works.
- [ ] With the network disabled in the browser's dev tools, every page
      renders fully — no request leaves `localhost`.
- [ ] Every row of the UI table is reachable with the Playwright locator
      kinds of ADR-0003 without `{ css }`: a reviewer checks the accessible
      names in the accessibility tree.
- [ ] `/slow` shows the spinner for 1 500 ms ± 100 ms, measured in the
      Performance panel.

## Parallel plan

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i2-fixture | the fixture app | apps/fixture/**, bun.lock | — | yes | sonnet |

## Contention

| Resource | Owner | Everyone else |
|---|---|---|
| bun.lock | i2-fixture | runs in parallel with #1; whichever merges second rebases and reruns `bun install` |

## Risks

- **Glass UI needs a peer this app does not install** (low). Mitigation: copy
  the peer list that `apps/web/package.json` already satisfies.
