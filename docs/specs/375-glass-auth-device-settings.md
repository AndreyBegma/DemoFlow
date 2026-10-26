# Glass UI for sign-in, sign-up, password reset, device approval and account settings

Issue: [#375](https://github.com/AndreyBegma/DemoFlow/issues/375)
Depends on: #373 (the theme and Glass UI 0.37.0; device and settings sit in the shell)

## Summary

The auth pages (`/sign-in`, `/sign-up`, `/verify-email`, `/forgot-password`,
`/reset-password`) all render through `AuthCard`
(`apps/web/src/components/auth/auth-card.tsx`): a plain `Card` centred on an
empty page [Confirmed]. They are the first thing a new user sees after the
landing page, and the device page (`/app/device`) is where `demoflow login`
sends them — today a narrow column with a form. Account settings
(`/app/settings`) is a single column of sections. None of them has a brand
mark, and none follows the theme the user picked (that arrives with #373).

This slice gives the auth pages a branded glass frame, makes device approval a
clear, single-purpose screen, and lays out account settings as sections inside
the shell — with the same forms, flows and API calls.

## Scope

### In scope

- `apps/web/src/components/auth/**`: `auth-card.tsx` (the frame),
  `form-parts.tsx`, the forms (`sign-in-form.tsx`, `sign-up-form.tsx`,
  `forgot-password-form.tsx`, `reset-password-form.tsx`, `verify-email.tsx`,
  `resend-button.tsx`), `unlink-github-button.tsx`; their visuals only.
- `apps/web/src/app/{sign-in,sign-up,verify-email,forgot-password,reset-password}/page.tsx`.
- `apps/web/src/app/app/device/page.tsx`, `apps/web/src/components/device/**`.
- `apps/web/src/app/app/settings/page.tsx`, `apps/web/src/components/settings/**`.
- `apps/web/src/i18n/en.ts`: keys these pages add.

### Out of scope

- Auth logic, validation, throttling, GitHub OAuth, session handling.
- The shell around device and settings (#373).
- The landing page and docs (#376), except that they may import `logo.tsx`.

## Decisions

1. **Auth frame: a glass panel on a quiet background.** The auth pages are
   outside `/app`, so they have no shell. `AuthCard` becomes: the logo above,
   a glass `Card` (max-w-md) with the title, the form and the footer links, on
   the page background with a soft gradient from the theme tokens (no image).
   Forms stay inside the card on the readable field surface — glass is the
   frame, not the fields (vision §9).
2. **Same forms, Glass UI fields.** Every input is `@andrewbehma/glass-ui/field`
   (already used in `form-parts.tsx` [Confirmed]); errors stay `Banner`s;
   primary actions are full-width solid `Button`s; "Continue with GitHub"
   (`ProviderSlot`, shown only while the API has GitHub credentials, spec 126
   Decision 5) gets the GitHub mark from `lucide-react` (already a dependency
   [Confirmed]).
3. **Device approval is one decision on one screen.** The page states which
   code it is approving in large monospace (the code from the URL, or the
   entry form when there is none), the machine/CLI context the API returns,
   and two buttons: Approve (solid) and Deny. After approval: a success state
   ("You can close this tab, `demoflow` is signed in") instead of returning to
   a form. Behaviour of `device-approval.tsx` / `device-code-form.tsx` is
   unchanged.
4. **One brand component.** The auth pages use
   `apps/web/src/components/brand/logo.tsx`, which #373 creates for the
   sidebar; #376 uses it on the landing and docs headers.
5. **Settings as sections.** Inside the shell: `PageHeader` "Account settings",
   then sections — Profile (email, verification state), Sign-in methods
   (password, GitHub link/unlink), Danger zone (delete account,
   `ConfirmDialog`, existing `delete-account.tsx` flow). The theme control
   stays in the account menu (#373, Open question) and settings links to it
   with one line.
6. **Both themes.** Every page here is checked in light and dark; no colour
   outside the Glass UI tokens.

## Acceptance criteria

- [ ] Each auth page renders the logo, a glass card and the form; at 375 px
      there is no horizontal scroll and the card has a 16 px gutter.
- [ ] Every flow still works end to end: sign up → verify email → sign in;
      forgot → reset → sign in; sign in with GitHub when configured, hidden
      when not (`/api/auth/providers` `{ github: false }`).
- [ ] `/app/device?code=XXXX-XXXX` shows the code, Approve and Deny; approving
      shows the success state; a wrong or expired code shows the existing error
      in a `Banner`.
- [ ] Settings shows the three sections; unlink GitHub and delete account
      keep their confirmations.
- [ ] Text and focus rings meet WCAG AA contrast in both themes (values in the PR).
- [ ] `bun run check`, `bun run build`, `bun run --filter web test` pass.
- [ ] The PR has screenshots of sign-in, sign-up, device approval (before and
      after approve) and settings in both themes.

## Parallel plan

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i375-auth | auth frame, device, settings | apps/web/src/components/auth/**, apps/web/src/components/device/**, apps/web/src/components/settings/**, apps/web/src/app/sign-in/**, apps/web/src/app/sign-up/**, apps/web/src/app/verify-email/**, apps/web/src/app/forgot-password/**, apps/web/src/app/reset-password/**, apps/web/src/app/app/device/**, apps/web/src/app/app/settings/**, apps/web/src/i18n/en.ts | #373 | yes | sonnet |

It can run in parallel with #374 and #376: no shared file except `en.ts`
(append-only).

## Contention

| Resource | Owner | Everyone else |
|---|---|---|
| apps/web/src/components/brand/logo.tsx | #373 | this slice imports it, never edits it |
| apps/web/src/app/app/settings/page.tsx, device/page.tsx | i375-auth (body) | #373 removed their header rows first |
| apps/web/src/i18n/en.ts | i375-auth | append-only; whoever merges second rebases |

## Risks

- **A broken auth flow is a locked-out user** (high). Mitigation: no logic
  change; the PR records each flow of the acceptance list run against staging
  or a local stack.
- **Glass behind form fields hurts legibility** (medium). Mitigation:
  Decision 1 — fields on the solid field surface; contrast values in the PR.

## Open questions

- **Background on the auth pages.** Default: the token gradient only, no
  illustration.
