# i18n dictionary for web UI strings

Issue: [#121](https://github.com/AndreyBegma/DemoFlow/issues/121) · Phase 5 ·
Roadmap: [roadmap.md](../product/roadmap.md) (Phase 5: "English UI, with
strings in an i18n dictionary from the start")

## Summary

The web app is about to gain its first real pages: sign-in (slice 2 of #120)
and the landing page. The roadmap asks for UI strings in a dictionary from the
start, so translating later is a data change and not a rewrite. Today
`apps/web` has one page with its strings inline and no i18n setup
[Confirmed: `apps/web/src/app/page.tsx`, `apps/web/next.config.ts`]. This
slice adds the dictionary and a typed lookup, and moves the existing strings
onto it.

## Scope

### In scope

- `apps/web/src/i18n/`:
  - `en.ts`: the English dictionary, a nested `as const` object.
  - `index.ts`: exports `t(key, params?)`.
  - `index.ts` also exports `Locale = 'en'` and `messages`.
- **Typed keys.** `key` is a union of the dotted paths of `en.ts`, so a missing
  or misspelt key fails `tsc` and `next build`.
- **Interpolation.** `{name}` placeholders, filled from `params`. A missing
  param is a type error.
- **Usage everywhere.** `t()` works in server and client components. It is a
  pure function with no context provider while there is one locale.
- **Migration.** `app/page.tsx` and the `metadata` in `app/layout.tsx` use
  `t()`.
- **Documentation.** A short "UI strings" section in `apps/web/README.md`, or
  in `CONTRIBUTING`/docs if web has no README: every user-facing string goes
  through `t()`.

### Out of scope

- Locale detection, routing by locale (`/[locale]`), a second language,
  plurals beyond what a caller formats, and dates and numbers (`Intl` at the
  call site).

## Decisions

1. **A separate slice, before the sign-in pages.** (owner, 2026-10-20) It
   touches only `apps/web` and runs in parallel with #120.
2. **Hand-rolled, no dependency.** (orchestrator) With one locale and no
   locale routing, a typed object and a 20-line `t()` cover the need. When a
   second locale arrives, the dictionary shape (nested keys, `{param}`) is
   compatible with `next-intl`, so switching is a mechanical port. This also
   keeps `bun.lock` free for the parallel #120 slot.

## Acceptance criteria

- [ ] `t('home.title')` returns the English string, and `t('x.missing')` fails
      `bun run build` (shown in the PR by a temporary commit or a `tsc` excerpt).
- [ ] A string with `{name}` requires `params.name` at the type level, and
      substitutes it at runtime.
- [ ] `app/page.tsx` and `layout.tsx` metadata contain no user-facing string
      literals.
- [ ] The rendered home page is unchanged (screenshot before and after in
      the PR).
- [ ] No new dependency. `bun run check` and `bun run build` pass. Woodpecker
      is green.

## Parallel plan

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i121 | the dictionary | apps/web/src/**, apps/web/README.md | — | yes | sonnet |

This is one slot, and it is mechanical once the shape above is fixed, so it is
`sonnet`.

## Contention

| Resource | Owner | Everyone else |
|---|---|---|
| bun.lock, apps/web/package.json | nobody: this slot adds no dependency | — |

## Risks

- **The typed key union slows the type checker on a large dictionary** (low).
  Mitigation: nested keys with a depth limit of four.
